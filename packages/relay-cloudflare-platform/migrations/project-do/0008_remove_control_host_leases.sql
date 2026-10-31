-- Custom SQL migration file, put your code below! --
-- Relay-internal control hosts stored a short-lived `ctl_` Channel credential for each Runtime operation and deleted
-- it afterwards; host connections opened with an AppCredential stored one that nothing deleted. Runtime operations now
-- run in the Runtime's RuntimeRelay without storing a credential, and nothing authorizes these rows any more.
DELETE FROM `channel_host_credentials`
 WHERE `credential_id` LIKE 'ctl\_%' ESCAPE '\'
   AND `authority` = 'linked'
   AND `source_grant_id` IS NULL;
