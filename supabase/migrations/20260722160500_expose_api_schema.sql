alter role authenticator set pgrst.db_schemas to 'api';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
