CREATE TABLE IF NOT EXISTS public_playlists (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  manifest_hash varchar(64) NOT NULL UNIQUE,
  title varchar(240) NOT NULL,
  track_count integer NOT NULL,
  volume_count integer NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'listed',
  published_at timestamptz NOT NULL,
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_playlists_title_check CHECK(length(btrim(title))>0),
  CONSTRAINT public_playlists_track_count_check CHECK(track_count>0),
  CONSTRAINT public_playlists_volume_count_check CHECK(volume_count>0),
  CONSTRAINT public_playlists_status_check CHECK(status IN ('listed','hidden')),
  CONSTRAINT public_playlists_hidden_state_check CHECK(
    (status='listed' AND hidden_at IS NULL) OR (status='hidden' AND hidden_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS public_playlist_status_published_idx
  ON public_playlists(status,published_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public_playlist_volumes (
  public_playlist_id uuid NOT NULL REFERENCES public_playlists(id) ON DELETE CASCADE,
  volume_number integer NOT NULL,
  name varchar(240) NOT NULL,
  track_count integer NOT NULL,
  share_url text NOT NULL UNIQUE,
  CONSTRAINT public_playlist_volumes_pkey PRIMARY KEY(public_playlist_id,volume_number),
  CONSTRAINT public_playlist_volumes_number_check CHECK(volume_number>0),
  CONSTRAINT public_playlist_volumes_name_check CHECK(length(btrim(name))>0),
  CONSTRAINT public_playlist_volumes_track_count_check CHECK(track_count>0),
  CONSTRAINT public_playlist_volumes_share_url_check CHECK(
    share_url ~ '^https://music[.]apple[.]com/[A-Za-z]{2}/playlist/.+/pl[.][A-Za-z0-9._-]+$'
  )
);
--> statement-breakpoint
WITH stable_publications AS (
  SELECT
    m.id AS manifest_id,
    m.run_id,
    m.content_hash,
    m.name,
    (SELECT count(*)::int FROM manifest_tracks mt WHERE mt.manifest_id=m.id) AS track_count,
    max(pv.volume_count)::int AS volume_count,
    max(pv.published_at) AS published_at
  FROM manifests m
  JOIN research_runs r ON r.id=m.run_id
  JOIN publication_volumes pv ON pv.manifest_id=m.id
  WHERE r.status IN ('complete','partial')
  GROUP BY m.id,m.run_id,m.content_hash,m.name
  HAVING count(*)=max(pv.volume_count)
     AND min(pv.volume_count)=max(pv.volume_count)
     AND min(pv.volume_number)=1
     AND max(pv.volume_number)=max(pv.volume_count)
     AND count(DISTINCT pv.volume_number)=count(*)
     AND bool_and(pv.status='complete')
     AND bool_and(pv.published_at IS NOT NULL)
     AND bool_and(pv.appended_count=pv.end_position-pv.start_position+1)
     AND bool_and(
       pv.apple_share_url ~ '^https://music[.]apple[.]com/[A-Za-z]{2}/playlist/.+/pl[.][A-Za-z0-9._-]+([?].*)?$'
     )
     AND sum(pv.end_position-pv.start_position+1)=(
       SELECT count(*)::int FROM manifest_tracks mt WHERE mt.manifest_id=m.id
     )
), latest_stable_publications AS (
  SELECT DISTINCT ON (content_hash) *
  FROM stable_publications
  WHERE track_count>0 AND volume_count>0
  ORDER BY content_hash,published_at DESC,manifest_id DESC
)
INSERT INTO public_playlists(
  id,run_id,manifest_hash,title,track_count,volume_count,status,published_at
)
SELECT
  md5(random()::text || clock_timestamp()::text || manifest_id::text)::uuid,
  run_id,
  content_hash,
  left(btrim(name),240),
  track_count,
  volume_count,
  'listed',
  published_at
FROM latest_stable_publications
ON CONFLICT(manifest_hash) DO UPDATE SET
  run_id=EXCLUDED.run_id,
  title=EXCLUDED.title,
  track_count=EXCLUDED.track_count,
  volume_count=EXCLUDED.volume_count,
  published_at=EXCLUDED.published_at,
  updated_at=now();
--> statement-breakpoint
INSERT INTO public_playlist_volumes(public_playlist_id,volume_number,name,track_count,share_url)
SELECT
  p.id,
  pv.volume_number,
  CASE WHEN pv.volume_count=1 THEN p.title
       ELSE left(p.title,220) || ' [' || pv.volume_number || '/' || pv.volume_count || ']'
  END,
  pv.end_position-pv.start_position+1,
  split_part(pv.apple_share_url,'?',1)
FROM public_playlists p
JOIN manifests m ON m.content_hash=p.manifest_hash AND m.run_id=p.run_id
JOIN publication_volumes pv ON pv.manifest_id=m.id
WHERE pv.status='complete'
  AND pv.published_at IS NOT NULL
  AND pv.appended_count=pv.end_position-pv.start_position+1
  AND pv.apple_share_url ~ '^https://music[.]apple[.]com/[A-Za-z]{2}/playlist/.+/pl[.][A-Za-z0-9._-]+([?].*)?$'
ON CONFLICT(public_playlist_id,volume_number) DO UPDATE SET
  name=EXCLUDED.name,
  track_count=EXCLUDED.track_count,
  share_url=EXCLUDED.share_url;
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','11')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
