-- Track wallet tokenization state (Apple Pay / Google Pay) per user card

ALTER TABLE user_cards
  ADD COLUMN IF NOT EXISTS apple_pay_provisioned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_pay_provisioned BOOLEAN NOT NULL DEFAULT false;

