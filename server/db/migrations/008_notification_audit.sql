ALTER TABLE notification_jobs ADD COLUMN delivery_dry_run boolean;
CREATE INDEX notification_audit_due ON notification_jobs(available_at, created_at)
  WHERE state='audit_pending';
-- Existing pending audits did not retain the delivery mode. Leave it unknown.
