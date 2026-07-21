using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Blue Shark Sender")]
[assembly: AssemblyDescription("Local supervisor for the Blue Shark WhatsApp sender")]
[assembly: AssemblyCompany("Blue Shark")]
[assembly: AssemblyProduct("Blue Shark Sender")]
[assembly: AssemblyCopyright("Copyright © Blue Shark 2026")]
[assembly: AssemblyVersion("1.2.2.0")]
[assembly: AssemblyFileVersion("1.2.2.0")]
[assembly: AssemblyInformationalVersion("1.2.2")]

namespace BlueShark.Sender.Launcher
{
    internal static class Program
    {
        private const string ExpectedAppId = "blue-shark-sender";
        private const string LauncherVersion = "1.2.2";
        private const int DefaultPort = 32147;
        // First startup can include a verified legacy-session migration and an ACL reset.
        private const int HealthTimeoutSeconds = 300;
        private const int RestartWindowMinutes = 10;
        private const int MaximumRestartsInWindow = 5;

        private static readonly object ChildLock = new object();
        private static readonly object LogLock = new object();
        private static readonly ManualResetEvent StopRequested = new ManualResetEvent(false);
        private static readonly Regex AppIdPattern = new Regex(
            "\\\"appId\\\"\\s*:\\s*\\\"blue-shark-sender\\\"",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex TokenPattern = new Regex(
            "\\\"token\\\"\\s*:\\s*\\\"([0-9a-fA-F]{64})\\\"",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static Process currentChild;
        private static IntPtr currentJob = IntPtr.Zero;
        private static string currentServerToken;
        private static int currentServerPort;
        private static string applicationRoot;
        private static string logPath;
        private static ConsoleControlHandler consoleControlHandler;
        private static bool systemEventsSubscribed;

        [STAThread]
        private static int Main()
        {
            applicationRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            logPath = Path.Combine(applicationRoot, "data", "launcher.log");

            string mutexName = BuildPerUserMutexName();
            bool ownsMutex = false;
            Mutex singleInstance = null;

            try
            {
                singleInstance = new Mutex(true, mutexName, out ownsMutex);
                if (!ownsMutex)
                {
                    int existingPort;
                    string existingPortError;
                    if (!IsEnvironmentFlagEnabled("BLUE_SHARK_NO_OPEN_BROWSER") &&
                        TryResolvePort(out existingPort, out existingPortError) &&
                        IsExpectedServerHealthy(existingPort))
                    {
                        OpenApplication(existingPort);
                    }
                    return 0;
                }

                RegisterShutdownHandlers();
                Log("launcher_start version=" + LauncherVersion);

                int updateResult = CheckForApplicationUpdate();
                if (updateResult == 10)
                {
                    Log("update_handoff_started");
                    return 0;
                }

                int port;
                string portError;
                if (!TryResolvePort(out port, out portError))
                {
                    Log("configuration_error " + portError);
                    ShowFatal(portError);
                    return 11;
                }

                string nodePath = Path.Combine(applicationRoot, "runtime", "node.exe");
                string serverPath = Path.Combine(applicationRoot, "app", "server.js");
                if (!File.Exists(nodePath) || !File.Exists(serverPath))
                {
                    string missingMessage = "ملفات تشغيل البرنامج غير مكتملة. أعد استخراج الحزمة كاملة ثم حاول مرة أخرى.";
                    Log("startup_files_missing node=" + File.Exists(nodePath) + " server=" + File.Exists(serverPath));
                    ShowFatal(missingMessage);
                    return 12;
                }

                return RunSupervisor(nodePath, serverPath, port);
            }
            catch (Exception ex)
            {
                Log("launcher_fatal " + SafeException(ex));
                ShowFatal("تعذر تشغيل برنامج الإرسال. راجع ملف data\\launcher.log للتفاصيل.");
                return 99;
            }
            finally
            {
                RequestStop();
                StopCurrentChild();
                CloseCurrentJob();
                UnregisterShutdownHandlers();

                if (ownsMutex && singleInstance != null)
                {
                    try
                    {
                        singleInstance.ReleaseMutex();
                    }
                    catch
                    {
                    }
                }

                if (singleInstance != null)
                {
                    singleInstance.Dispose();
                }

                Log("launcher_stop");
            }
        }

        private static int CheckForApplicationUpdate()
        {
            try
            {
                string updater = Path.Combine(applicationRoot, "tools", "Update_Blue_Shark.ps1");
                if (!File.Exists(updater) || IsEnvironmentFlagEnabled("BLUE_SHARK_SKIP_UPDATE"))
                {
                    return 0;
                }

                string powershell = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell", "v1.0", "powershell.exe");
                if (!File.Exists(powershell))
                {
                    Log("update_check_skipped powershell_missing");
                    return 0;
                }

                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = powershell;
                info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + QuoteArgument(updater) +
                    " -Mode Check -CurrentVersion " + QuoteArgument(LauncherVersion) +
                    " -ParentPid " + Process.GetCurrentProcess().Id;
                info.WorkingDirectory = applicationRoot;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process process = Process.Start(info))
                {
                    if (process == null) return 0;
                    if (!process.WaitForExit(360000))
                    {
                        try { process.Kill(); } catch { }
                        Log("update_check_timeout");
                        return 0;
                    }
                    Log("update_check_exit code=" + process.ExitCode);
                    return process.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Log("update_check_error " + SafeException(ex));
                return 0;
            }
        }

        private static int RunSupervisor(string nodePath, string serverPath, int port)
        {
            currentServerPort = port;
            Queue<DateTime> recentFailures = new Queue<DateTime>();
            int consecutiveFailures = 0;
            bool browserOpened = false;

            while (!StopRequested.WaitOne(0))
            {
                DateTime childStartedAt = DateTime.UtcNow;
                Process child = null;
                IntPtr childJob = IntPtr.Zero;
                bool healthy = false;
                int exitCode = -1;

                try
                {
                    child = StartNode(nodePath, serverPath);
                    childJob = CreateKillOnCloseJob(child);
                    SetCurrentChild(child, childJob);
                    Log("node_start pid=" + child.Id + " port=" + port);

                    healthy = WaitForHealthyServer(child, port, HealthTimeoutSeconds);
                    if (healthy)
                    {
                        Log("server_healthy pid=" + child.Id);
                        if (!browserOpened && !IsEnvironmentFlagEnabled("BLUE_SHARK_NO_OPEN_BROWSER"))
                        {
                            browserOpened = OpenApplication(port);
                        }
                    }
                    else if (!HasExited(child) && !StopRequested.WaitOne(0))
                    {
                        Log("health_timeout pid=" + child.Id);
                        StopProcess(child);
                    }

                    WaitForExitOrStop(child);
                    if (StopRequested.WaitOne(0))
                    {
                        StopProcess(child);
                        return 0;
                    }

                    exitCode = GetExitCode(child);
                    Log("node_exit pid=" + SafeProcessId(child) + " code=" + exitCode + " healthy=" + healthy);
                }
                catch (Exception ex)
                {
                    Log("node_cycle_failure " + SafeException(ex));
                    if (child != null)
                    {
                        StopProcess(child);
                    }
                }
                finally
                {
                    ClearCurrentChild(child);
                    CloseJob(childJob);
                    if (child != null)
                    {
                        child.Dispose();
                    }
                }

                if (exitCode == 0)
                {
                    Log("node_requested_stop");
                    return 0;
                }

                TimeSpan uptime = DateTime.UtcNow - childStartedAt;
                if (healthy && uptime >= TimeSpan.FromMinutes(2))
                {
                    consecutiveFailures = 0;
                }

                consecutiveFailures++;
                DateTime now = DateTime.UtcNow;
                recentFailures.Enqueue(now);
                while (recentFailures.Count > 0 && now - recentFailures.Peek() > TimeSpan.FromMinutes(RestartWindowMinutes))
                {
                    recentFailures.Dequeue();
                }

                if (recentFailures.Count > MaximumRestartsInWindow)
                {
                    Log("restart_limit_exceeded failures=" + recentFailures.Count);
                    ShowFatal("تعذر إبقاء برنامج الإرسال قيد التشغيل بعد عدة محاولات. راجع data\\launcher.log ثم شغّل البرنامج مجددًا.");
                    return 20;
                }

                int delaySeconds = CalculateBackoffSeconds(consecutiveFailures);
                Log("restart_scheduled attempt=" + recentFailures.Count + " delay_seconds=" + delaySeconds);
                if (StopRequested.WaitOne(TimeSpan.FromSeconds(delaySeconds)))
                {
                    return 0;
                }
            }

            return 0;
        }

        private static Process StartNode(string nodePath, string serverPath)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodePath;
            startInfo.Arguments = QuoteArgument(serverPath);
            startInfo.WorkingDirectory = applicationRoot;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.ErrorDialog = false;
            startInfo.EnvironmentVariables["BLUE_SHARK_APP_ROOT"] = applicationRoot;
            startInfo.EnvironmentVariables["BLUE_SHARK_LAUNCHED_BY"] = "supervisor-" + LauncherVersion;

            Process process = new Process();
            process.StartInfo = startInfo;
            process.EnableRaisingEvents = false;
            if (!process.Start())
            {
                process.Dispose();
                throw new InvalidOperationException("Node process did not start.");
            }

            return process;
        }

        private static bool WaitForHealthyServer(Process child, int port, int timeoutSeconds)
        {
            Stopwatch timer = Stopwatch.StartNew();
            while (timer.Elapsed < TimeSpan.FromSeconds(timeoutSeconds))
            {
                if (StopRequested.WaitOne(0) || HasExited(child))
                {
                    return false;
                }

                if (IsExpectedServerHealthy(port))
                {
                    return true;
                }

                if (StopRequested.WaitOne(400))
                {
                    return false;
                }
            }

            return false;
        }

        private static bool IsExpectedServerHealthy(int port)
        {
            HttpWebRequest request = null;
            try
            {
                request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/config");
                request.Method = "GET";
                request.Proxy = null;
                request.KeepAlive = false;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.UserAgent = "BlueSharkSenderLauncher/" + LauncherVersion;

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        return false;
                    }

                    if (response.ContentLength > 65536)
                    {
                        return false;
                    }

                    using (Stream stream = response.GetResponseStream())
                    {
                        if (stream == null)
                        {
                            return false;
                        }

                        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 1024))
                        {
                            char[] buffer = new char[8192];
                            int read = reader.ReadBlock(buffer, 0, buffer.Length);
                            string body = new string(buffer, 0, read);
                            if (!AppIdPattern.IsMatch(body))
                            {
                                return false;
                            }

                            Match tokenMatch = TokenPattern.Match(body);
                            lock (ChildLock)
                            {
                                currentServerToken = tokenMatch.Success ? tokenMatch.Groups[1].Value : null;
                            }

                            return true;
                        }
                    }
                }
            }
            catch (WebException)
            {
                return false;
            }
            catch (IOException)
            {
                return false;
            }
            catch (ObjectDisposedException)
            {
                return false;
            }
            finally
            {
                if (request != null)
                {
                    try
                    {
                        request.Abort();
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static bool OpenApplication(int port)
        {
            try
            {
                ProcessStartInfo openInfo = new ProcessStartInfo();
                openInfo.FileName = "http://127.0.0.1:" + port + "/";
                openInfo.UseShellExecute = true;
                Process opened = Process.Start(openInfo);
                if (opened != null)
                {
                    opened.Dispose();
                }

                Log("browser_opened port=" + port);
                return true;
            }
            catch (Exception ex)
            {
                Log("browser_open_failed " + SafeException(ex));
                return false;
            }
        }

        private static void WaitForExitOrStop(Process child)
        {
            while (!HasExited(child))
            {
                if (StopRequested.WaitOne(500))
                {
                    StopProcessGracefully(child);
                    break;
                }
            }

            try
            {
                child.WaitForExit(5000);
            }
            catch
            {
            }
        }

        private static void StopProcess(Process process)
        {
            if (process == null || HasExited(process))
            {
                return;
            }

            try
            {
                process.CloseMainWindow();
            }
            catch
            {
            }

            try
            {
                if (process.WaitForExit(1500))
                {
                    return;
                }
            }
            catch
            {
            }

            try
            {
                process.Kill();
                process.WaitForExit(5000);
            }
            catch
            {
            }
        }

        private static void StopProcessGracefully(Process process)
        {
            if (process == null || HasExited(process))
            {
                return;
            }

            if (TryRequestGracefulStop())
            {
                for (int attempt = 0; attempt < 16; attempt++)
                {
                    try
                    {
                        if (process.WaitForExit(500))
                        {
                            Log("node_graceful_stop_complete pid=" + SafeProcessId(process));
                            return;
                        }
                    }
                    catch
                    {
                        break;
                    }
                }

                Log("node_graceful_stop_timeout pid=" + SafeProcessId(process));
            }

            StopProcess(process);
        }

        private static bool TryRequestGracefulStop()
        {
            string token;
            int port;
            lock (ChildLock)
            {
                token = currentServerToken;
                port = currentServerPort;
            }

            if (String.IsNullOrEmpty(token) || port < 1)
            {
                return false;
            }

            HttpWebRequest request = null;
            try
            {
                request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/stop");
                request.Method = "POST";
                request.Proxy = null;
                request.KeepAlive = false;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentLength = 0;
                request.Headers["X-Blue-Shark-Token"] = token;
                request.UserAgent = "BlueSharkSenderLauncher/" + LauncherVersion;

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    bool accepted = response.StatusCode == HttpStatusCode.OK;
                    Log("graceful_stop_request accepted=" + accepted);
                    return accepted;
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse response = ex.Response as HttpWebResponse;
                Log("graceful_stop_request_failed status=" + (response == null ? "none" : ((int)response.StatusCode).ToString()));
                if (response != null)
                {
                    response.Dispose();
                }
                return false;
            }
            catch (Exception ex)
            {
                Log("graceful_stop_request_failed " + SafeException(ex));
                return false;
            }
            finally
            {
                if (request != null)
                {
                    try
                    {
                        request.Abort();
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static void SetCurrentChild(Process child, IntPtr job)
        {
            lock (ChildLock)
            {
                currentChild = child;
                currentJob = job;
                currentServerToken = null;
            }
        }

        private static void ClearCurrentChild(Process child)
        {
            lock (ChildLock)
            {
                if (Object.ReferenceEquals(currentChild, child))
                {
                    currentChild = null;
                    currentJob = IntPtr.Zero;
                    currentServerToken = null;
                }
            }
        }

        private static void StopCurrentChild()
        {
            Process child;
            lock (ChildLock)
            {
                child = currentChild;
            }

            StopProcessGracefully(child);
        }

        private static void CloseCurrentJob()
        {
            IntPtr job;
            lock (ChildLock)
            {
                job = currentJob;
                currentJob = IntPtr.Zero;
            }

            CloseJob(job);
        }

        private static IntPtr CreateKillOnCloseJob(Process child)
        {
            IntPtr job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                Log("job_create_failed win32=" + Marshal.GetLastWin32Error());
                return IntPtr.Zero;
            }

            NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsPointer = Marshal.AllocHGlobal(length);
            bool keepJob = false;

            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!NativeMethods.SetInformationJobObject(
                    job,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    limitsPointer,
                    (uint)length))
                {
                    Log("job_configure_failed win32=" + Marshal.GetLastWin32Error());
                    return IntPtr.Zero;
                }

                if (!NativeMethods.AssignProcessToJobObject(job, child.Handle))
                {
                    Log("job_assign_failed pid=" + SafeProcessId(child) + " win32=" + Marshal.GetLastWin32Error());
                    return IntPtr.Zero;
                }

                keepJob = true;
                return job;
            }
            catch (Exception ex)
            {
                Log("job_setup_failed " + SafeException(ex));
                return IntPtr.Zero;
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPointer);
                if (!keepJob)
                {
                    NativeMethods.CloseHandle(job);
                }
            }
        }

        private static void CloseJob(IntPtr job)
        {
            if (job != IntPtr.Zero)
            {
                try
                {
                    NativeMethods.CloseHandle(job);
                }
                catch
                {
                }
            }
        }

        private static void RegisterShutdownHandlers()
        {
            consoleControlHandler = delegate(ConsoleControlType controlType)
            {
                RequestStop();
                return true;
            };

            try
            {
                NativeMethods.SetConsoleCtrlHandler(consoleControlHandler, true);
            }
            catch
            {
            }

            AppDomain.CurrentDomain.ProcessExit += delegate { RequestStop(); };

            try
            {
                SystemEvents.SessionEnding += OnSessionEnding;
                SystemEvents.SessionEnded += OnSessionEnded;
                systemEventsSubscribed = true;
            }
            catch (Exception ex)
            {
                Log("session_event_registration_failed " + SafeException(ex));
            }
        }

        private static void UnregisterShutdownHandlers()
        {
            try
            {
                if (consoleControlHandler != null)
                {
                    NativeMethods.SetConsoleCtrlHandler(consoleControlHandler, false);
                }
            }
            catch
            {
            }

            if (systemEventsSubscribed)
            {
                try
                {
                    SystemEvents.SessionEnding -= OnSessionEnding;
                    SystemEvents.SessionEnded -= OnSessionEnded;
                }
                catch
                {
                }
            }
        }

        private static void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            Log("windows_session_ending reason=" + e.Reason);
            RequestStop();
            StopCurrentChild();
        }

        private static void OnSessionEnded(object sender, SessionEndedEventArgs e)
        {
            RequestStop();
            StopCurrentChild();
        }

        private static void RequestStop()
        {
            try
            {
                StopRequested.Set();
            }
            catch
            {
            }
        }

        private static bool TryResolvePort(out int port, out string error)
        {
            string rawPort = Environment.GetEnvironmentVariable("BLUE_SHARK_PORT");
            string source = "BLUE_SHARK_PORT";
            if (String.IsNullOrWhiteSpace(rawPort))
            {
                rawPort = Environment.GetEnvironmentVariable("PORT");
                source = "PORT";
            }

            if (String.IsNullOrWhiteSpace(rawPort))
            {
                port = DefaultPort;
                error = null;
                return true;
            }

            if (!Int32.TryParse(rawPort.Trim(), out port) || port < 1 || port > 65535)
            {
                error = "قيمة المنفذ في " + source + " غير صحيحة. استخدم رقمًا من 1 إلى 65535.";
                return false;
            }

            error = null;
            return true;
        }

        private static bool IsEnvironmentFlagEnabled(string name)
        {
            string value = Environment.GetEnvironmentVariable(name);
            return String.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
        }

        private static int CalculateBackoffSeconds(int consecutiveFailures)
        {
            int exponent = Math.Max(0, Math.Min(consecutiveFailures - 1, 5));
            return Math.Min(30, 1 << exponent);
        }

        private static string BuildPerUserMutexName()
        {
            try
            {
                WindowsIdentity identity = WindowsIdentity.GetCurrent();
                if (identity != null && identity.User != null)
                {
                    return "Local\\BlueSharkSender-" + identity.User.Value;
                }
            }
            catch
            {
            }

            return "Local\\BlueSharkSender-" + StableHash(Environment.UserDomainName + "\\" + Environment.UserName);
        }

        private static string StableHash(string value)
        {
            unchecked
            {
                uint hash = 2166136261;
                for (int i = 0; i < value.Length; i++)
                {
                    hash ^= value[i];
                    hash *= 16777619;
                }

                return hash.ToString("X8");
            }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static bool HasExited(Process process)
        {
            if (process == null)
            {
                return true;
            }

            try
            {
                return process.HasExited;
            }
            catch
            {
                return true;
            }
        }

        private static int GetExitCode(Process process)
        {
            try
            {
                return process.ExitCode;
            }
            catch
            {
                return -1;
            }
        }

        private static int SafeProcessId(Process process)
        {
            try
            {
                return process.Id;
            }
            catch
            {
                return -1;
            }
        }

        private static string SafeException(Exception exception)
        {
            if (exception == null)
            {
                return "unknown";
            }

            string message = exception.Message == null ? String.Empty : exception.Message.Replace('\r', ' ').Replace('\n', ' ');
            if (message.Length > 500)
            {
                message = message.Substring(0, 500);
            }

            return exception.GetType().Name + ": " + message;
        }

        private static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    string directory = Path.GetDirectoryName(logPath);
                    if (!Directory.Exists(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }

                    if (File.Exists(logPath) && new FileInfo(logPath).Length > 1024 * 1024)
                    {
                        string previousLog = logPath + ".1";
                        if (File.Exists(previousLog))
                        {
                            File.Delete(previousLog);
                        }

                        File.Move(logPath, previousLog);
                    }

                    File.AppendAllText(
                        logPath,
                        DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch
            {
            }
        }

        private static void ShowFatal(string message)
        {
            if (IsEnvironmentFlagEnabled("BLUE_SHARK_NO_UI"))
            {
                return;
            }

            try
            {
                MessageBox.Show(
                    message,
                    "Blue Shark Sender",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error,
                    MessageBoxDefaultButton.Button1,
                    MessageBoxOptions.RightAlign | MessageBoxOptions.RtlReading);
            }
            catch
            {
            }
        }
    }

    internal enum ConsoleControlType : uint
    {
        CtrlC = 0,
        CtrlBreak = 1,
        Close = 2,
        Logoff = 5,
        Shutdown = 6
    }

    internal delegate bool ConsoleControlHandler(ConsoleControlType controlType);

    internal static class NativeMethods
    {
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        internal const int JobObjectExtendedLimitInformation = 9;

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetConsoleCtrlHandler(ConsoleControlHandler handler, bool add);
    }
}
