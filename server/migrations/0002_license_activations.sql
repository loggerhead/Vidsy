-- M2: track which devices consumed a license activation. The activation limit
-- is enforced in the Worker (Creem is called first) and recorded here so the
-- same device can re-activate without consuming another slot.

CREATE TABLE license_activations (
  key_hash TEXT NOT NULL REFERENCES license_keys(key_hash),
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, device_id)
);

CREATE INDEX idx_license_activations_device ON license_activations (device_id);
