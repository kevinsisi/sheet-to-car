ALTER TABLE car_copies ADD COLUMN confirmed_feature_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE car_copies ADD COLUMN pending_field_count INTEGER NOT NULL DEFAULT 0;
