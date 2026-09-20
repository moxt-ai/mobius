CREATE TABLE `immutable_content` (
	`object_key` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`byte_length` integer NOT NULL,
	`content_encoding` text NOT NULL,
	`media_type` text NOT NULL,
	`sha256` text NOT NULL,
	CONSTRAINT "immutable_content_byte_length_check" CHECK(byte_length >= 0),
	CONSTRAINT "immutable_content_content_encoding_check" CHECK(content_encoding IN ('gzip', 'identity')),
	CONSTRAINT "immutable_content_sha256_check" CHECK(length(sha256) = 64)
);
