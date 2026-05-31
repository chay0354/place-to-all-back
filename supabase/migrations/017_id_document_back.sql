-- Back side of government ID (front remains in id_document_path)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS id_document_back_path TEXT;

COMMENT ON COLUMN profiles.id_document_back_path IS 'Storage object path for ID back side in private bucket id-documents (userId/id-back.ext).';
