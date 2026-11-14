-- Forward-only, transactionally applied with its backfill by the migration runner.
-- Downgrading a populated installation requires a new forward migration; retain
-- the source labels and immutable observations rather than dropping provenance.
-- These are conservative source projections, not an authoritative court registry.
CREATE FUNCTION geography_label(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT regexp_replace(value, '^[[:space:]]+|[[:space:]]+$', '', 'g')
  $$;

CREATE TABLE states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE CHECK (label <> '' AND label = geography_label(label)),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,label)
);
ALTER TABLE sources ADD COLUMN state_id uuid REFERENCES states(id);
CREATE INDEX sources_state_idx ON sources(state_id);

-- A jurisdiction is a portal's asserted state scope, not a county, district,
-- appellate hierarchy, or a claim that two portals represent the same tribunal.
-- The empty source_key records an unknown state without inventing a state row.
CREATE TABLE jurisdictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  source_key text NOT NULL CHECK (source_key = geography_label(source_key)),
  state_id uuid,
  name text NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id,source_key),
  UNIQUE (id,source_id),
  CHECK ((state_id IS NULL) = (source_key = '')),
  FOREIGN KEY (state_id,source_key) REFERENCES states(id,label)
);
CREATE INDEX jurisdictions_state_idx ON jurisdictions(state_id);

CREATE TABLE courts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  jurisdiction_id uuid NOT NULL,
  source_key text NOT NULL CHECK (source_key <> '' AND source_key = geography_label(name)),
  name text NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id,jurisdiction_id,source_key),
  UNIQUE (id,jurisdiction_id,source_id),
  FOREIGN KEY (jurisdiction_id,source_id) REFERENCES jurisdictions(id,source_id)
);
CREATE INDEX courts_jurisdiction_idx ON courts(jurisdiction_id,source_id);

ALTER TABLE cases ADD COLUMN jurisdiction_id uuid;
ALTER TABLE cases ADD COLUMN court_id uuid;
ALTER TABLE cases ADD CONSTRAINT cases_jurisdiction_scope_fk
  FOREIGN KEY (jurisdiction_id,source_id) REFERENCES jurisdictions(id,source_id);
ALTER TABLE cases ADD CONSTRAINT cases_court_scope_fk
  FOREIGN KEY (court_id,jurisdiction_id,source_id) REFERENCES courts(id,jurisdiction_id,source_id);
CREATE INDEX cases_jurisdiction_idx ON cases(jurisdiction_id,source_id);
CREATE INDEX cases_court_idx ON cases(court_id,jurisdiction_id,source_id);

CREATE FUNCTION synchronize_source_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_key text := geography_label(NEW.state);
BEGIN
  NEW.state_id := NULL;
  IF state_key <> '' THEN
    SELECT id INTO NEW.state_id FROM states WHERE label=state_key;
    IF NEW.state_id IS NULL THEN
      INSERT INTO states(label,provenance)
        VALUES (state_key,jsonb_build_object('field','sources.state','sourceId',NEW.id,
          'sourceValue',NEW.state,'matching','trim-only','version',1))
        ON CONFLICT (label) DO NOTHING;
      -- A separate statement sees the winner after a concurrent insert commits.
      SELECT id INTO NEW.state_id FROM states WHERE label=state_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sources_state BEFORE INSERT OR UPDATE OF state,state_id ON sources
  FOR EACH ROW EXECUTE FUNCTION synchronize_source_state();

CREATE FUNCTION synchronize_source_jurisdiction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jurisdictions(source_id,source_key,state_id,name,provenance)
    VALUES (NEW.id,geography_label(NEW.state),NEW.state_id,NEW.name,
      jsonb_build_object('field','sources.state','sourceId',NEW.id,'sourceValue',NEW.state,
        'sourceName',NEW.name,'scope','source-state','matching','trim-only','version',1))
    ON CONFLICT (source_id,source_key) DO NOTHING;
  -- A source state correction creates a new scope and reprojects current cases;
  -- old jurisdiction/court rows and observation JSON remain historical evidence.
  IF TG_OP='UPDATE' THEN
    IF OLD.state IS DISTINCT FROM NEW.state OR OLD.state_id IS DISTINCT FROM NEW.state_id THEN
      UPDATE cases SET source_id=source_id WHERE source_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sources_jurisdiction AFTER INSERT OR UPDATE OF state,state_id ON sources
  FOR EACH ROW EXECUTE FUNCTION synchronize_source_jurisdiction();

CREATE FUNCTION synchronize_case_geography() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  court_key text := geography_label(NEW.court);
BEGIN
  SELECT j.id INTO NEW.jurisdiction_id
    FROM sources s JOIN jurisdictions j ON j.source_id=s.id AND j.source_key=geography_label(s.state)
    WHERE s.id=NEW.source_id;
  IF NEW.jurisdiction_id IS NULL THEN
    RAISE EXCEPTION 'Case source % has no registered jurisdiction scope', NEW.source_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  NEW.court_id := NULL;
  IF court_key <> '' THEN
    SELECT id INTO NEW.court_id FROM courts
      WHERE source_id=NEW.source_id AND jurisdiction_id=NEW.jurisdiction_id AND source_key=court_key;
    IF NEW.court_id IS NULL THEN
      INSERT INTO courts(source_id,jurisdiction_id,source_key,name,provenance)
        VALUES (NEW.source_id,NEW.jurisdiction_id,court_key,NEW.court,
          jsonb_build_object('field','cases.court','sourceId',NEW.source_id,
            'sourceCaseId',NEW.source_case_id,'sourceValue',NEW.court,
            'matching','trim-only','version',1))
        ON CONFLICT (source_id,jurisdiction_id,source_key) DO NOTHING;
      SELECT id INTO NEW.court_id FROM courts
        WHERE source_id=NEW.source_id AND jurisdiction_id=NEW.jurisdiction_id AND source_key=court_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cases_geography BEFORE INSERT OR UPDATE OF source_id,court ON cases
  FOR EACH ROW EXECUTE FUNCTION synchronize_case_geography();

-- Reuse exactly the ingestion triggers for both existing and future records.
-- No acquisition flags, scheduling fields, original labels, or snapshots change.
UPDATE sources SET state=state;
UPDATE cases SET court=court;
ALTER TABLE cases ALTER COLUMN jurisdiction_id SET NOT NULL;
