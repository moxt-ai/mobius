ALTER TABLE bot_execution_bindings
ADD COLUMN execution_configuration_json TEXT NOT NULL
DEFAULT '{"model":{"booleanValue":false,"configId":"model","value":"agent_default","valueType":"select"},"permissionMode":"agent_default","reasoningEffort":{"booleanValue":false,"configId":"reasoning_effort","value":"agent_default","valueType":"select"}}';
