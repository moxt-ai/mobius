-- App lifecycle and credentials belong to Platform's control-plane database.
-- Shared Project routes no longer read or issue these legacy credentials.
DROP TABLE project_application_credentials;
DROP TABLE project_applications;
