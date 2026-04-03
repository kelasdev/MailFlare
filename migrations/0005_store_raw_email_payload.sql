ALTER TABLE emails ADD COLUMN body_text TEXT;
ALTER TABLE emails ADD COLUMN body_html TEXT;
ALTER TABLE emails ADD COLUMN raw_mime TEXT;
ALTER TABLE emails ADD COLUMN headers_json TEXT;
