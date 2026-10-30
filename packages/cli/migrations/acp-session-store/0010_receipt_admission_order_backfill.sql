-- Receipts written before admission order existed are ordered by their last update, after every ordered receipt.
UPDATE `execution_receipt` SET `admission_order` = `ordered`.`admission_order`
FROM (
    SELECT
        `command_id`,
        (SELECT coalesce(max(`admission_order`), 0) FROM `execution_receipt`)
            + row_number() OVER (ORDER BY `updated_at`, `command_id`) AS `admission_order`
    FROM `execution_receipt`
    WHERE `admission_order` IS NULL
) AS `ordered`
WHERE `execution_receipt`.`command_id` = `ordered`.`command_id`;
