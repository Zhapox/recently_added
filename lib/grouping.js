'use strict';

/**
 * Pure helpers for grouping MPD `find` results.
 *
 * Extracted from index.js so they can be unit-tested without spinning
 * up the controller.  Nothing in here touches `this`, the filesystem,
 * or any Volumio API — given the same input, output is deterministic.
 *
 * Three functions:
 *   - artistOf(entry)         → string (AlbumArtist / Artist / "Unknown Artist")
 *   - albumTitleOf(entry, fallback) → string (Album tag, with fallback)
 *   - groupByAlbum(entries)   → array of album buckets, sorted by recency
 */

/**
 * Determine the artist for grouping.  AlbumArtist is preferred because
 * compilations have a single AlbumArtist (e.g. "Various Artists") even
 * when individual tracks have different per-track Artist values.
 *
 * Falls back to Artist, then to "Unknown Artist".  Note that the literal
 * "Unknown Artist" string is intentionally not localized here — it would
 * conflict with grouping (two locales would produce two buckets for the
 * same set of tag-less files).  Display-side localization, if desired,
 * can map this sentinel value to a translated label at render time.
 */
function artistOf(entry) {
  return entry.AlbumArtist || entry.Artist || 'Unknown Artist';
}

/**
 * Return the most-common Album tag value across the given entries.
 * Used to title an album bucket when we have multiple tracks for the
 * same folder.  Falls back to the supplied `fallback` string if no
 * track in the bucket has an Album tag.
 *
 * Why most-common rather than first?  Sloppy tagging sometimes leaves
 * a stray empty or differently-cased Album value on a single track,
 * and we want the consensus value to win.  For typical well-tagged
 * libraries every track has the same value, so either approach works;
 * for messy ones, mode is a small robustness improvement.
 */
function albumTitleOf(entries, fallback) {
  var counts = {};
  for (var i = 0; i < entries.length; i++) {
    var album = entries[i].Album;
    if (!album) continue;
    counts[album] = (counts[album] || 0) + 1;
  }
  var best = null;
  var bestCount = 0;
  var keys = Object.keys(counts);
  for (var k = 0; k < keys.length; k++) {
    if (counts[keys[k]] > bestCount) {
      best = keys[k];
      bestCount = counts[keys[k]];
    }
  }
  return best || fallback;
}

/**
 * Group `find` entries by parent directory.  Returns array sorted by
 * most-recent modification descending.  Each bucket carries the entries
 * themselves so the caller can derive an Album-tag title.
 *
 * The bucket's `modified` is the MAX across its tracks — re-adding a
 * single track to an existing folder bumps the whole album back to the
 * top of the list, which matches user expectation.
 */
function groupByAlbum(entries) {
  var albumMap = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.file) continue;
    var albumPath = e.file.split('/').slice(0, -1).join('/');
    if (!albumPath) continue;  // file at root — skip

    var modified = e['Last-Modified'] ? new Date(e['Last-Modified']).getTime() : 0;
    if (!albumMap[albumPath]) {
      albumMap[albumPath] = {
        path: albumPath,
        modified: modified,
        entries: [e]
      };
    } else {
      if (modified > albumMap[albumPath].modified) {
        albumMap[albumPath].modified = modified;
      }
      albumMap[albumPath].entries.push(e);
    }
  }
  var albums = Object.keys(albumMap).map(function (k) { return albumMap[k]; });
  albums.sort(function (a, b) { return b.modified - a.modified; });
  return albums;
}

module.exports = {
  artistOf: artistOf,
  albumTitleOf: albumTitleOf,
  groupByAlbum: groupByAlbum
};
