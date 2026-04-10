ALTER TABLE car_copies ADD COLUMN validation_status TEXT NOT NULL DEFAULT '';
ALTER TABLE car_copies ADD COLUMN validation_error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE car_copies ADD COLUMN validation_warning_count INTEGER NOT NULL DEFAULT 0;
