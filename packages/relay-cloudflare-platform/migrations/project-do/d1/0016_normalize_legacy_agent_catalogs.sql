-- Agent descriptors released before the Bot API removal carried
-- botSessionConfiguration. New writes are strictly validated without that
-- field, so normalize the persisted released shape once instead of retaining
-- application compatibility for it.
UPDATE pairing_channels
   SET agents_json = (
       SELECT COALESCE(
           json_group_array(json(
               CASE
                   WHEN json_type(entry.value, '$.botSessionConfiguration') IN ('true', 'false')
                   THEN json_remove(entry.value, '$.botSessionConfiguration')
                   ELSE entry.value
               END
           )),
           '[]'
       )
       FROM json_each(pairing_channels.agents_json) AS entry
   )
 WHERE json_valid(agents_json)
   AND json_type(agents_json) = 'array'
   AND EXISTS (
       SELECT 1
         FROM json_each(pairing_channels.agents_json) AS entry
        WHERE json_type(entry.value, '$.botSessionConfiguration') IN ('true', 'false')
   );
