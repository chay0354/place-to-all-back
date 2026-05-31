-- Private identity document (government ID photo) — path in storage bucket id-documents
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS id_document_path TEXT,
  ADD COLUMN IF NOT EXISTS id_document_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.id_document_path IS 'Storage object path in private bucket id-documents (userId/id.ext).';
COMMENT ON COLUMN profiles.id_document_uploaded_at IS 'When the user last uploaded an ID document.';

INSERT INTO storage.buckets (id, name, public)
VALUES ('id-documents', 'id-documents', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "Users can read own id documents" ON storage.objects;
CREATE POLICY "Users can read own id documents"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'id-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Users can upload own id documents" ON storage.objects;
CREATE POLICY "Users can upload own id documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'id-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Users can update own id documents" ON storage.objects;
CREATE POLICY "Users can update own id documents"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'id-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'id-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "Users can delete own id documents" ON storage.objects;
CREATE POLICY "Users can delete own id documents"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'id-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
