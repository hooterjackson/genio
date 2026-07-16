/**
 * Metadata the deterministic sequencer can use. Missing values are neutral:
 * they are never synthesized and do not contribute to transition scoring.
 */
export interface PlaylistSequenceTrack {
  artist: string;
  artistId?: string | null;
  album?: string | null;
  albumId?: string | null;
  genre?: string | readonly string[] | null;
  year?: number | null;
  releaseYear?: number | null;
  durationMs?: number | null;
  bpm?: number | null;
  key?: string | null;
}

/**
 * Keeps the source position explicit, so even two identical values (or two
 * occurrences of the same object reference) remain distinct playlist rows.
 */
export interface SequencedPlaylistRow<T extends PlaylistSequenceTrack> {
  sourceIndex: number;
  track: T;
}

interface NormalizedTransitionMetadata {
  genres: ReadonlySet<string> | null;
  year: number | null;
  durationMs: number | null;
  bpm: number | null;
  key: NormalizedMusicalKey | null;
}

interface InternalRow<T extends PlaylistSequenceTrack> {
  sourceIndex: number;
  track: T;
  artistKey: string;
  albumKey: string;
  metadata: NormalizedTransitionMetadata;
  selected: boolean;
}

interface AlbumState<T extends PlaylistSequenceTrack> {
  key: string;
  firstIndex: number;
  rows: InternalRow<T>[];
  cursor: number;
  remaining: number;
}

interface ArtistState<T extends PlaylistSequenceTrack> {
  key: string;
  firstIndex: number;
  remaining: number;
  albums: BinaryHeap<AlbumState<T>>;
}

interface TrackProposal<T extends PlaylistSequenceTrack> {
  artist: ArtistState<T>;
  album: AlbumState<T>;
  row: InternalRow<T>;
  transition: TransitionScore;
}

interface TransitionScore {
  value: number;
  comparedWeight: number;
}

interface CountState {
  key: string;
  firstIndex: number;
  remaining: number;
  revision: number;
}

interface CountEntry {
  state: CountState;
  remaining: number;
  revision: number;
}

export type PlaylistTransitionPreference = "smooth" | "contrast";

export interface PlaylistSequencingOptions {
  transitionPreference?: PlaylistTransitionPreference;
}

type NormalizedMusicalKey =
  | { kind: "camelot"; number: number; letter: "a" | "b"; raw: string }
  | { kind: "pitch"; pitchClass: number; mode: "major" | "minor" | null; raw: string }
  | { kind: "text"; raw: string };

const ARTIST_LOOKAHEAD = 16;
const ALBUM_LOOKAHEAD = 8;
const TRACK_LOOKAHEAD = 4;
const SCORE_EPSILON = 1e-9;
const FIXED_ORDER_POLICY =
  /\b(?:chronolog(?:ic|ical|ically|y)?|alphabet(?:ic|ical|ically)?|rank(?:ed|ing)?|source|evidence|discovery|release\s+date|original\s+order|user\s+order|catalog(?:ue)?\s+order)\b/iu;
const FLOW_ORDER_POLICY =
  /\b(?:flow|intermix|mix|transition|sequence|arc|journey|energy|smooth|dj|playlist)\b/iu;

/**
 * Respect an explicit fixed-order request. Curated playlists otherwise use
 * flow sequencing by default; exhaustive catalogues retain their source order
 * unless the confirmed brief explicitly asks for a listening flow.
 */
export function shouldSequencePlaylist(
  orderingPolicy: string | null | undefined,
  mode: "curated" | "hybrid" | "exhaustive" = "curated",
): boolean {
  const policy = orderingPolicy?.trim() ?? "";
  if (FIXED_ORDER_POLICY.test(policy)) return false;
  if (FLOW_ORDER_POLICY.test(policy)) return true;
  return mode === "curated";
}

class BinaryHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly higherPriority: (left: T, right: T) => boolean) {}

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    const values = this.values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = values[parent];
      if (parentValue === undefined || !this.higherPriority(value, parentValue)) break;
      values[index] = parentValue;
      index = parent;
    }
    values[index] = value;
  }

  pop(): T | undefined {
    const values = this.values;
    const root = values[0];
    const tail = values.pop();
    if (root === undefined || tail === undefined || values.length === 0) return root;

    let index = 0;
    values[0] = tail;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      const bestValue = values[best];
      const leftValue = values[left];
      const rightValue = values[right];
      if (leftValue !== undefined && bestValue !== undefined && this.higherPriority(leftValue, bestValue)) {
        best = left;
      }
      const currentBest = values[best];
      if (rightValue !== undefined && currentBest !== undefined && this.higherPriority(rightValue, currentBest)) {
        best = right;
      }
      if (best === index) break;
      const swap = values[index];
      const replacement = values[best];
      if (swap === undefined || replacement === undefined) break;
      values[index] = replacement;
      values[best] = swap;
      index = best;
    }
    return root;
  }
}

function normalizedGroupValue(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function identityKey(
  id: string | null | undefined,
  label: string | null | undefined,
  missingPrefix: string,
  sourceIndex: number,
): string {
  const normalizedId = normalizedGroupValue(id);
  if (normalizedId) return `id:${normalizedId}`;
  const normalizedLabel = normalizedGroupValue(label);
  if (normalizedLabel) return `name:${normalizedLabel}`;
  // Unknown values are not evidence that two rows share an artist or album.
  return `${missingPrefix}:${sourceIndex}`;
}

function finiteInRange(value: number | null | undefined, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function normalizeGenres(value: PlaylistSequenceTrack["genre"]): ReadonlySet<string> | null {
  const rawValues = typeof value === "string" ? [value] : value;
  if (!rawValues) return null;
  const genres = new Set<string>();
  for (const rawValue of rawValues) {
    for (const part of rawValue.split(/[,;/|]+/gu)) {
      const normalized = normalizedGroupValue(part);
      if (normalized) genres.add(normalized);
    }
  }
  return genres.size > 0 ? genres : null;
}

const PITCH_CLASSES: Readonly<Record<string, number>> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  fb: 4,
  "e#": 5,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
  cb: 11,
  "b#": 0,
};

function normalizeMusicalKey(value: string | null | undefined): NormalizedMusicalKey | null {
  const raw = normalizedGroupValue(value)
    .replace(/♯/gu, "#")
    .replace(/♭/gu, "b");
  if (!raw) return null;

  const camelot = raw.match(/^(1[0-2]|[1-9])\s*([ab])$/u);
  if (camelot) {
    const number = Number(camelot[1]);
    const letter = camelot[2];
    if (letter === "a" || letter === "b") {
      return { kind: "camelot", number, letter, raw: `${number}${letter}` };
    }
  }

  const pitch = raw.match(/^([a-g])\s*([#b]?)\s*(major|minor|maj|min|m)?$/u);
  if (pitch) {
    const pitchName = `${pitch[1] ?? ""}${pitch[2] ?? ""}`;
    const pitchClass = PITCH_CLASSES[pitchName];
    if (pitchClass !== undefined) {
      const modeValue = pitch[3];
      const mode = modeValue === "m" || modeValue === "min" || modeValue === "minor"
        ? "minor"
        : modeValue === "maj" || modeValue === "major"
          ? "major"
          : null;
      return { kind: "pitch", pitchClass, mode, raw };
    }
  }

  return { kind: "text", raw };
}

function normalizeTransitionMetadata(track: PlaylistSequenceTrack): NormalizedTransitionMetadata {
  return {
    genres: normalizeGenres(track.genre),
    year: finiteInRange(track.year ?? track.releaseYear, 1000, 3000),
    durationMs: finiteInRange(track.durationMs, 1, 24 * 60 * 60 * 1000),
    bpm: finiteInRange(track.bpm, 1, 400),
    key: normalizeMusicalKey(track.key),
  };
}

function genreSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const genre of left) {
    if (right.has(genre)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function tempoSimilarity(left: number, right: number): number {
  const distance = Math.min(
    Math.abs(left - right),
    Math.abs(left * 2 - right),
    Math.abs(left - right * 2),
  );
  return 1 - Math.min(distance / 40, 1);
}

function circularDistance(left: number, right: number, modulus: number): number {
  const direct = Math.abs(left - right);
  return Math.min(direct, modulus - direct);
}

function keySimilarity(left: NormalizedMusicalKey, right: NormalizedMusicalKey): number | null {
  if (left.raw === right.raw) return 1;

  if (left.kind === "camelot" && right.kind === "camelot") {
    const numberDistance = circularDistance(left.number - 1, right.number - 1, 12);
    if (left.letter === right.letter && numberDistance === 1) return 0.9;
    if (left.number === right.number && left.letter !== right.letter) return 0.85;
    return 0;
  }

  if (left.kind === "pitch" && right.kind === "pitch") {
    if (left.pitchClass === right.pitchClass && left.mode === right.mode) return 1;
    if (left.mode && right.mode && left.mode !== right.mode) {
      const major = left.mode === "major" ? left : right;
      const minor = left.mode === "minor" ? left : right;
      if ((major.pitchClass + 9) % 12 === minor.pitchClass) return 0.9;
    }
    const distance = circularDistance(left.pitchClass, right.pitchClass, 12);
    if (left.mode === right.mode && distance === 5) return 0.8;
    return 0;
  }

  // Differing unparsed labels are not assumed to be harmonically unrelated.
  return null;
}

function transitionScore(
  previous: NormalizedTransitionMetadata | null,
  next: NormalizedTransitionMetadata,
): TransitionScore {
  if (!previous) return { value: 0.5, comparedWeight: 0 };

  let weightedScore = 0;
  let comparedWeight = 0;
  const add = (similarity: number | null, weight: number): void => {
    if (similarity === null) return;
    weightedScore += similarity * weight;
    comparedWeight += weight;
  };

  add(previous.genres && next.genres ? genreSimilarity(previous.genres, next.genres) : null, 0.25);
  add(
    previous.year !== null && next.year !== null
      ? 1 - Math.min(Math.abs(previous.year - next.year) / 30, 1)
      : null,
    0.15,
  );
  add(
    previous.durationMs !== null && next.durationMs !== null
      ? 1 - Math.min(Math.abs(previous.durationMs - next.durationMs) / 240_000, 1)
      : null,
    0.1,
  );
  add(
    previous.bpm !== null && next.bpm !== null
      ? tempoSimilarity(previous.bpm, next.bpm)
      : null,
    0.3,
  );
  add(previous.key && next.key ? keySimilarity(previous.key, next.key) : null, 0.2);

  return {
    // No comparable metadata is neutral rather than guessed.
    value: comparedWeight > 0 ? weightedScore / comparedWeight : 0.5,
    comparedWeight,
  };
}

function albumHigherPriority<T extends PlaylistSequenceTrack>(
  left: AlbumState<T>,
  right: AlbumState<T>,
): boolean {
  return left.remaining > right.remaining
    || (left.remaining === right.remaining && left.firstIndex < right.firstIndex);
}

function artistHigherPriority<T extends PlaylistSequenceTrack>(
  left: ArtistState<T>,
  right: ArtistState<T>,
): boolean {
  return left.remaining > right.remaining
    || (left.remaining === right.remaining && left.firstIndex < right.firstIndex);
}

function countEntryHigherPriority(left: CountEntry, right: CountEntry): boolean {
  return left.remaining > right.remaining
    || (left.remaining === right.remaining && left.state.firstIndex < right.state.firstIndex);
}

function firstAvailableRows<T extends PlaylistSequenceTrack>(
  album: AlbumState<T>,
  maximum: number,
): InternalRow<T>[] {
  const rows: InternalRow<T>[] = [];
  for (let index = album.cursor; index < album.rows.length && rows.length < maximum; index += 1) {
    const row = album.rows[index];
    if (row && !row.selected) rows.push(row);
  }
  return rows;
}

function proposalScore<T extends PlaylistSequenceTrack>(
  proposal: TrackProposal<T>,
  maximumArtistRemaining: number,
  transitionPreference: PlaylistTransitionPreference,
): number {
  const artistUrgency = maximumArtistRemaining > 0
    ? proposal.artist.remaining / maximumArtistRemaining
    : 0;
  const albumUrgency = proposal.artist.remaining > 0
    ? proposal.album.remaining / proposal.artist.remaining
    : 0;
  const transitionValue = transitionPreference === "contrast"
    ? 1 - proposal.transition.value
    : proposal.transition.value;
  return transitionValue * 0.68 + artistUrgency * 0.24 + albumUrgency * 0.08;
}

function betterProposal<T extends PlaylistSequenceTrack>(
  left: TrackProposal<T>,
  right: TrackProposal<T>,
  maximumArtistRemaining: number,
  transitionPreference: PlaylistTransitionPreference,
): boolean {
  const leftScore = proposalScore(left, maximumArtistRemaining, transitionPreference);
  const rightScore = proposalScore(right, maximumArtistRemaining, transitionPreference);
  if (Math.abs(leftScore - rightScore) > SCORE_EPSILON) return leftScore > rightScore;
  if (left.transition.comparedWeight !== right.transition.comparedWeight) {
    return left.transition.comparedWeight > right.transition.comparedWeight;
  }
  if (left.artist.remaining !== right.artist.remaining) {
    return left.artist.remaining > right.artist.remaining;
  }
  if (left.album.remaining !== right.album.remaining) {
    return left.album.remaining > right.album.remaining;
  }
  return left.row.sourceIndex < right.row.sourceIndex;
}

function trackProposalsForArtist<T extends PlaylistSequenceTrack>(
  artist: ArtistState<T>,
  previous: InternalRow<T> | null,
  transitionPreference: PlaylistTransitionPreference,
): TrackProposal<T>[] {
  const poppedAlbums: AlbumState<T>[] = [];
  while (artist.albums.size > 0 && poppedAlbums.length < ALBUM_LOOKAHEAD) {
    const album = artist.albums.pop();
    if (album) poppedAlbums.push(album);
  }

  const proposals: TrackProposal<T>[] = [];
  for (const album of poppedAlbums) {
    const rows = firstAvailableRows(album, TRACK_LOOKAHEAD);
    let bestRow: InternalRow<T> | null = null;
    let bestTransition: TransitionScore | null = null;
    for (const row of rows) {
      const transition = transitionScore(previous?.metadata ?? null, row.metadata);
      if (
        !bestRow
        || !bestTransition
        || (
          transitionPreference === "smooth"
            ? transition.value > bestTransition.value + SCORE_EPSILON
            : transition.value < bestTransition.value - SCORE_EPSILON
        )
        || (
          Math.abs(transition.value - bestTransition.value) <= SCORE_EPSILON
          && (
            transition.comparedWeight > bestTransition.comparedWeight
            || (
              transition.comparedWeight === bestTransition.comparedWeight
              && row.sourceIndex < bestRow.sourceIndex
            )
          )
        )
      ) {
        bestRow = row;
        bestTransition = transition;
      }
    }
    if (bestRow && bestTransition) {
      proposals.push({ artist, album, row: bestRow, transition: bestTransition });
    }
  }

  for (const album of poppedAlbums) artist.albums.push(album);
  return proposals;
}

function groupSafeAfterSelection(
  selectedRemaining: number,
  maximumOtherRemaining: number,
  remainingTotal: number,
): boolean {
  return selectedRemaining <= Math.floor(remainingTotal / 2)
    && maximumOtherRemaining <= Math.ceil(remainingTotal / 2);
}

function maximumOtherArtistRemaining<T extends PlaylistSequenceTrack>(
  selected: ArtistState<T>,
  topArtists: readonly ArtistState<T>[],
): number {
  for (const artist of topArtists) {
    if (artist !== selected) return artist.remaining;
  }
  return 0;
}

function topValidCountStates(heap: BinaryHeap<CountEntry>, maximum: number): CountState[] {
  const entries: CountEntry[] = [];
  while (heap.size > 0 && entries.length < maximum) {
    const entry = heap.pop();
    if (!entry) break;
    if (
      entry.revision !== entry.state.revision
      || entry.remaining !== entry.state.remaining
      || entry.state.remaining <= 0
    ) {
      continue;
    }
    entries.push(entry);
  }
  for (const entry of entries) heap.push(entry);
  return entries.map((entry) => entry.state);
}

function maximumOtherAlbumRemaining(
  selectedKey: string,
  topAlbums: readonly CountState[],
): number {
  for (const album of topAlbums) {
    if (album.key !== selectedKey) return album.remaining;
  }
  return 0;
}

function commitAlbumSelection<T extends PlaylistSequenceTrack>(
  artist: ArtistState<T>,
  proposal: TrackProposal<T>,
): void {
  const poppedAlbums: AlbumState<T>[] = [];
  let selectedAlbum: AlbumState<T> | null = null;
  while (artist.albums.size > 0 && poppedAlbums.length < ALBUM_LOOKAHEAD) {
    const album = artist.albums.pop();
    if (!album) break;
    if (album === proposal.album) {
      selectedAlbum = album;
      break;
    }
    poppedAlbums.push(album);
  }
  if (!selectedAlbum) {
    throw new Error("Sequencer invariant failed: selected album is unavailable");
  }

  proposal.row.selected = true;
  selectedAlbum.remaining -= 1;
  while (
    selectedAlbum.cursor < selectedAlbum.rows.length
    && selectedAlbum.rows[selectedAlbum.cursor]?.selected
  ) {
    selectedAlbum.cursor += 1;
  }

  for (const album of poppedAlbums) artist.albums.push(album);
  if (selectedAlbum.remaining > 0) artist.albums.push(selectedAlbum);
}

function buildState<T extends PlaylistSequenceTrack>(tracks: readonly T[]): {
  artistHeap: BinaryHeap<ArtistState<T>>;
  albumCountHeap: BinaryHeap<CountEntry>;
  albumCounts: Map<string, CountState>;
} {
  const artistMap = new Map<string, {
    key: string;
    firstIndex: number;
    rowsByAlbum: Map<string, InternalRow<T>[]>;
  }>();
  const albumCounts = new Map<string, CountState>();

  tracks.forEach((track, sourceIndex) => {
    const artistKey = identityKey(track.artistId, track.artist, "unknown-artist", sourceIndex);
    const albumKey = identityKey(track.albumId, track.album, "unknown-album", sourceIndex);
    const row: InternalRow<T> = {
      sourceIndex,
      track,
      artistKey,
      albumKey,
      metadata: normalizeTransitionMetadata(track),
      selected: false,
    };

    let artist = artistMap.get(artistKey);
    if (!artist) {
      artist = { key: artistKey, firstIndex: sourceIndex, rowsByAlbum: new Map() };
      artistMap.set(artistKey, artist);
    }
    const albumRows = artist.rowsByAlbum.get(albumKey);
    if (albumRows) albumRows.push(row);
    else artist.rowsByAlbum.set(albumKey, [row]);

    const count = albumCounts.get(albumKey);
    if (count) count.remaining += 1;
    else albumCounts.set(albumKey, {
      key: albumKey,
      firstIndex: sourceIndex,
      remaining: 1,
      revision: 0,
    });
  });

  const artistHeap = new BinaryHeap<ArtistState<T>>(artistHigherPriority);
  for (const artist of artistMap.values()) {
    const albumHeap = new BinaryHeap<AlbumState<T>>(albumHigherPriority);
    let remaining = 0;
    for (const [key, rows] of artist.rowsByAlbum) {
      albumHeap.push({
        key,
        firstIndex: rows[0]?.sourceIndex ?? artist.firstIndex,
        rows,
        cursor: 0,
        remaining: rows.length,
      });
      remaining += rows.length;
    }
    artistHeap.push({
      key: artist.key,
      firstIndex: artist.firstIndex,
      remaining,
      albums: albumHeap,
    });
  }

  const albumCountHeap = new BinaryHeap<CountEntry>(countEntryHigherPriority);
  for (const state of albumCounts.values()) {
    albumCountHeap.push({
      state,
      remaining: state.remaining,
      revision: state.revision,
    });
  }

  return { artistHeap, albumCountHeap, albumCounts };
}

/**
 * Deterministically sequence a playlist while retaining every input row.
 *
 * Artist and album adjacency are hard preferences whenever the bounded
 * candidate frontier can satisfy them. Feasibility guards keep dominant
 * groups from being deferred until they form an avoidable block. Within those
 * constraints, only supplied genre/year/duration/BPM/key metadata contributes
 * to transition quality. Runtime is O(n log n) with bounded lookahead.
 */
export function sequencePlaylistRows<T extends PlaylistSequenceTrack>(
  tracks: readonly T[],
  options: PlaylistSequencingOptions = {},
): SequencedPlaylistRow<T>[] {
  if (tracks.length === 0) return [];

  const { artistHeap, albumCountHeap, albumCounts } = buildState(tracks);
  const transitionPreference = options.transitionPreference ?? "smooth";
  const result: SequencedPlaylistRow<T>[] = [];
  let previous: InternalRow<T> | null = null;

  while (artistHeap.size > 0) {
    const candidateArtists: ArtistState<T>[] = [];
    while (artistHeap.size > 0 && candidateArtists.length < ARTIST_LOOKAHEAD) {
      const artist = artistHeap.pop();
      if (artist) candidateArtists.push(artist);
    }
    if (candidateArtists.length === 0) break;

    const proposals = candidateArtists.flatMap((artist) => (
      trackProposalsForArtist(artist, previous, transitionPreference)
    ));
    if (proposals.length === 0) {
      throw new Error("Sequencer invariant failed: no remaining track proposal");
    }

    const remainingAfterSelection = tracks.length - result.length - 1;
    const topAlbumCounts = topValidCountStates(albumCountHeap, 2);
    let eligible = proposals;

    if (previous) {
      const differentArtist = eligible.filter((proposal) => proposal.artist.key !== previous?.artistKey);
      if (differentArtist.length > 0) eligible = differentArtist;
    }

    const artistSafe = eligible.filter((proposal) => groupSafeAfterSelection(
      proposal.artist.remaining - 1,
      maximumOtherArtistRemaining(proposal.artist, candidateArtists),
      remainingAfterSelection,
    ));
    if (artistSafe.length > 0) eligible = artistSafe;

    if (previous) {
      const differentAlbum = eligible.filter((proposal) => proposal.album.key !== previous?.albumKey);
      if (differentAlbum.length > 0) eligible = differentAlbum;
    }

    const albumSafe = eligible.filter((proposal) => {
      const selectedAlbum = albumCounts.get(proposal.album.key);
      if (!selectedAlbum) return false;
      return groupSafeAfterSelection(
        selectedAlbum.remaining - 1,
        maximumOtherAlbumRemaining(selectedAlbum.key, topAlbumCounts),
        remainingAfterSelection,
      );
    });
    if (albumSafe.length > 0) eligible = albumSafe;

    const maximumArtistRemaining = candidateArtists[0]?.remaining ?? 1;
    let selected = eligible[0];
    if (!selected) throw new Error("Sequencer invariant failed: candidate set is empty");
    for (let index = 1; index < eligible.length; index += 1) {
      const proposal = eligible[index];
      if (proposal && betterProposal(
        proposal,
        selected,
        maximumArtistRemaining,
        transitionPreference,
      )) {
        selected = proposal;
      }
    }

    commitAlbumSelection(selected.artist, selected);
    selected.artist.remaining -= 1;

    for (const artist of candidateArtists) {
      if (artist.remaining > 0) artistHeap.push(artist);
    }

    const selectedAlbumCount = albumCounts.get(selected.album.key);
    if (!selectedAlbumCount) {
      throw new Error("Sequencer invariant failed: selected album count is unavailable");
    }
    selectedAlbumCount.remaining -= 1;
    selectedAlbumCount.revision += 1;
    if (selectedAlbumCount.remaining > 0) {
      albumCountHeap.push({
        state: selectedAlbumCount,
        remaining: selectedAlbumCount.remaining,
        revision: selectedAlbumCount.revision,
      });
    }

    result.push({ sourceIndex: selected.row.sourceIndex, track: selected.row.track });
    previous = selected.row;
  }

  if (result.length !== tracks.length) {
    throw new Error(`Sequencer invariant failed: emitted ${result.length} of ${tracks.length} rows`);
  }
  return result;
}

/** Convenience wrapper for callers that do not need source-position metadata. */
export function sequencePlaylist<T extends PlaylistSequenceTrack>(
  tracks: readonly T[],
  options: PlaylistSequencingOptions = {},
): T[] {
  return sequencePlaylistRows(tracks, options).map((row) => row.track);
}
