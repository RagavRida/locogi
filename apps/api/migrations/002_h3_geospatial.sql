-- ─── H3 Geospatial Indexing Migration ────────────────────────────────────────
-- Adds H3 hexagonal grid columns to vendors and requests
-- Resolution 8  ≈ 460m cell edge  (fine-grained: street-level)
-- Resolution 7  ≈ 1.2km cell edge (broad: neighbourhood-level)
-- Resolution 6  ≈ 3.2km cell edge (city-zone-level, fallback)

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS h3_r8 varchar(16),   -- ~460m hex
  ADD COLUMN IF NOT EXISTS h3_r7 varchar(16),   -- ~1.2km hex
  ADD COLUMN IF NOT EXISTS h3_r6 varchar(16);   -- ~3.2km hex (fallback)

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS h3_r8 varchar(16),
  ADD COLUMN IF NOT EXISTS h3_r7 varchar(16),
  ADD COLUMN IF NOT EXISTS h3_r6 varchar(16);

-- Fast lookup: find all vendors in a set of H3 cells
CREATE INDEX IF NOT EXISTS idx_vendors_h3_r8 ON vendors (h3_r8)
  WHERE h3_r8 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_h3_r7 ON vendors (h3_r7)
  WHERE h3_r7 IS NOT NULL;

-- Composite index: category filter + H3 (the hot query path)
CREATE INDEX IF NOT EXISTS idx_vendors_category_h3 ON vendors USING gin (category_tags)
  WHERE h3_r8 IS NOT NULL;
