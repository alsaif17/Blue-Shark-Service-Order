#define MyAppName "Blue Shark Sender"
#define MyAppVersion GetEnv("BLUE_SHARK_VERSION")
#define MyAppPublisher "Blue Shark"
#define MyAppExeName "BlueSharkSender.exe"

[Setup]
AppId={{0AFA1EDB-8EAB-45E7-922A-CAAC0E83EA1D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\BlueShark
DefaultGroupName={#MyAppName}
PrivilegesRequired=admin
OutputDir=..\release
OutputBaseFilename=Blue_Shark_Sender_Setup_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "arabic"; MessagesFile: "compiler:Languages\Arabic.isl"

[Files]
Source: "..\work\installer-source\Blue_Shark_WhatsApp_Sender_Portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Run {#MyAppName}"; Flags: nowait postinstall skipifsilent
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\tools\Install_Update_Agent.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated
