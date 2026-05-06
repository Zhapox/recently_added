'use strict';

/**
 * Volumio Recently Added Plugin
 *
 * Adds a "Recently Added" entry to the Browse menu, showing albums whose
 * files were modified within configurable time windows (last 7 / 14 / 30
 * / 90 days).  Backed entirely by MPD's `find modified-since` query —
 * no separate index, no watcher, no native modules.
 *
 * Architecture rationale:
 *   - MPD already maintains a database of every audio file with its
 *     Last-Modified timestamp.  We just query it.
 *   - The plugin's view is therefore always exactly aligned with what
 *     Volumio's other browse views (Albums, Artists, Music Library) can
 *     navigate.  No "phantom" entries that fail to open.
 *   - When the user adds new music, they trigger Volumio's library
 *     update as part of their normal workflow; that one action makes the
 *     music visible everywhere, including here.
 *
 * Architectural notes from the OLED plugin still apply:
 *   - Lifecycle methods MUST return kew promises (Volumio 4 plugin
 *     manager rejects native Promises).
 *   - Config persistence bypasses v-conf's auto-save (see
 *     _persistToManagedConfig) because v-conf overwrites synchronous
 *     writes with stale values.
 *   - onStart resolves even on failure (with a toast) — rejecting from
 *     onStart confuses the plugin manager.
 */

var fs = require('fs');
var path = require('path');
var libQ = require('/volumio/node_modules/kew');

var grouping = require('./lib/grouping');

module.exports = ControllerRecentlyAdded;

// ── Constants ─────────────────────────────────────────────────────────────

var DAY_MS = 24 * 60 * 60 * 1000;
var PLUGIN_URI = 'recently_added';                  // L5: single source of truth
var LIST_VIEWS = ['list', 'grid'];                  // L7
var SECTION_ICON = 'fa fa-clock-o';
var ALBUMS_ICON = 'fa fa-music';
var ARTISTS_ICON = 'fa fa-user';
var ERROR_ICON = 'fa fa-exclamation-triangle';

// MPD-relative → absolute filesystem path mappings, used for albumart
// URLs that need a path Volumio's albumart server can dereference.
// Defaults match Volumio's stock layout; M3 (dynamic discovery from
// /var/lib/mpd/music symlinks) is deferred per the v0.3.4 review.
var MPD_PATH_MAPPINGS = [
  { prefix: 'INTERNAL/', replacement: '/data/INTERNAL/' },
  { prefix: 'USB/',      replacement: '/mnt/USB/' },
  { prefix: 'NAS/',      replacement: '/mnt/NAS/' }
];

// Read once at module load (L8) — the version is immutable for the
// duration of the process.
var PKG_VERSION = '0.0.0';
try {
  PKG_VERSION = require('./package.json').version;
} catch (_) { }


// ═══════════════════════════════════════════════════════════════════════════
// Constructor
// ═══════════════════════════════════════════════════════════════════════════

function ControllerRecentlyAdded(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;

  this.config = null;
  this.mpdClient = null;
  this._sigTermHandler = null;            // L9
  this._strings = null;                   // cached translations for browse strings
}


// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

ControllerRecentlyAdded.prototype.onVolumioStart = function () {
  this._ensureConfig();
  return libQ.resolve();
};

ControllerRecentlyAdded.prototype.onStart = function () {
  var self = this;
  var defer = libQ.defer();

  self._ensureConfig();
  self._loadStrings();

  try {
    self._startPlugin();
    self._addToBrowseSources();
    self.logger.info('RecentlyAdded: plugin started');
    defer.resolve();
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    self.logger.error('RecentlyAdded: start failed: ' + msg);
    try {
      self.commandRouter.pushToastMessage('error', 'Recently Added',
        self._t('TOAST.START_FAILED', { message: msg }));
    } catch (_) { }
    // Resolve anyway; Volumio dislikes rejections from onStart
    defer.resolve();
  }

  return defer.promise;
};

ControllerRecentlyAdded.prototype.onStop = function () {
  var self = this;
  var defer = libQ.defer();

  try {
    if (self._sigTermHandler) {
      process.removeListener('SIGTERM', self._sigTermHandler);
      self._sigTermHandler = null;
    }
    if (self.mpdClient) {
      self.mpdClient.disconnect();
      self.mpdClient = null;
    }
    self.logger.info('RecentlyAdded: plugin stopped');
  } catch (err) {
    self.logger.error('RecentlyAdded: stop error: ' +
      ((err && err.message) ? err.message : err));
  }

  defer.resolve();
  return defer.promise;
};

ControllerRecentlyAdded.prototype._startPlugin = function () {
  var self = this;
  // Lazy-load to keep startup fast and avoid pulling in mpd if disabled
  var MpdClient = require('./lib/mpd-client');

  self.mpdClient = new MpdClient({
    host: self._getStr('mpd_host', 'localhost'),
    port: self._getInt('mpd_port', 6600),
    queryTimeoutMs: self._getInt('query_timeout_ms', 10000)
  }, self.logger);

  // L9: clean shutdown on SIGTERM.  The MPD connection itself is just a
  // TCP socket the kernel will reap, but closing it explicitly logs a
  // tidy shutdown and matches the OLED plugin's pattern.
  self._sigTermHandler = function () {
    self.logger.info('RecentlyAdded: SIGTERM — disconnecting MPD');
    try { if (self.mpdClient) self.mpdClient.disconnect(); } catch (_) { }
    process.exit(0);
  };
  process.on('SIGTERM', self._sigTermHandler);

  // We don't connect eagerly — first browse request will trigger it.
  // This avoids a startup-time error if MPD isn't ready yet.
};


// ═══════════════════════════════════════════════════════════════════════════
// Configuration helpers (lifted from oled_display_ssd1309)
// ═══════════════════════════════════════════════════════════════════════════

ControllerRecentlyAdded.prototype._getInt = function (key, fallback) {
  if (!this.config) return fallback;
  var raw = this.config.get(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  var val = parseInt(raw, 10);
  return isNaN(val) ? fallback : val;
};

ControllerRecentlyAdded.prototype._getStr = function (key, fallback) {
  if (!this.config) return fallback;
  var raw = this.config.get(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw);
};

ControllerRecentlyAdded.prototype._ensureConfig = function () {
  if (this.config) return;

  var vconf = require('/volumio/node_modules/v-conf');
  this.config = new vconf();

  try {
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(
      this.context, 'config.json'
    );
    this.config.loadFile(configFile);
    this.logger.info('RecentlyAdded: config loaded from ' + configFile);
    return;
  } catch (err) {
    this.logger.warn('RecentlyAdded: pluginManager config unavailable: ' +
      ((err && err.message) ? err.message : err));
  }

  // Fallback: bundled defaults, used during very early startup before
  // pluginManager has registered our config path.  Writes here may not
  // persist; this is a read-mostly safety net.
  try {
    var fallbackPath = path.join(__dirname, 'config.json');
    this.config.loadFile(fallbackPath);
    this.logger.warn('RecentlyAdded: config loaded from fallback: ' + fallbackPath);
  } catch (err2) {
    this.logger.error('RecentlyAdded: fallback config failed: ' +
      ((err2 && err2.message) ? err2.message : err2));
  }
};

/**
 * Discard the in-memory v-conf instance and reload from disk.  Required
 * after a saveConfig because v-conf's deferred auto-save would otherwise
 * overwrite our synchronous write with stale values.  H4 review item.
 */
ControllerRecentlyAdded.prototype._reloadConfig = function () {
  this.config = null;
  this._ensureConfig();
};

ControllerRecentlyAdded.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};


// ═══════════════════════════════════════════════════════════════════════════
// i18n helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load the appropriate translation file once at plugin start.  Used by
 * _t() for runtime browse-string lookups.  UIConfig.json's TRANSLATE.X
 * keys are resolved separately by Volumio's i18nJson — this loader is
 * specifically for strings shown in browse responses.
 */
ControllerRecentlyAdded.prototype._loadStrings = function () {
  var langCode = this.commandRouter.sharedVars.get('language_code') || 'en';
  var primary = path.join(__dirname, 'i18n', 'strings_' + langCode + '.json');
  var fallback = path.join(__dirname, 'i18n', 'strings_en.json');

  var strings = null;
  try {
    strings = JSON.parse(fs.readFileSync(primary, 'utf8'));
  } catch (_) {
    try {
      strings = JSON.parse(fs.readFileSync(fallback, 'utf8'));
    } catch (e) {
      this.logger.error('RecentlyAdded: i18n load failed: ' + e.message);
      strings = {};
    }
  }
  this._strings = strings;
};

/**
 * Look up a dotted key like "BROWSE.WINDOW_7D" in the loaded strings,
 * with optional {placeholder} substitution.  Falls back to the key
 * itself if the lookup fails — better to show a debug-shaped string
 * than crash, and it makes missing translations obvious in screenshots.
 */
ControllerRecentlyAdded.prototype._t = function (dottedKey, vars) {
  if (!this._strings) this._loadStrings();
  var parts = dottedKey.split('.');
  var node = this._strings;
  for (var i = 0; i < parts.length; i++) {
    if (node && typeof node === 'object' && parts[i] in node) {
      node = node[parts[i]];
    } else {
      return dottedKey;
    }
  }
  if (typeof node !== 'string') return dottedKey;
  if (vars) {
    return node.replace(/\{(\w+)\}/g, function (_, name) {
      return vars[name] !== undefined ? String(vars[name]) : '{' + name + '}';
    });
  }
  return node;
};

/**
 * Return a localized "N albums" / "N artists" string given a count and
 * a translation key prefix.  M7: handles two plural forms (one / many)
 * which covers the languages we ship.
 */
ControllerRecentlyAdded.prototype._countLabel = function (keyPrefix, n) {
  if (n === 1) return this._t(keyPrefix + '_ONE');
  return this._t(keyPrefix + '_MANY', { n: n });
};

/**
 * Map a window-days value to its localized title.  M6.
 */
ControllerRecentlyAdded.prototype._windowTitle = function (days) {
  return this._t('BROWSE.WINDOW_' + days + 'D');
};


// ═══════════════════════════════════════════════════════════════════════════
// UI Configuration
// ═══════════════════════════════════════════════════════════════════════════

ControllerRecentlyAdded.prototype.getUIConfig = function () {
  var defer = libQ.defer();
  var self = this;

  self._ensureConfig();

  var langCode = this.commandRouter.sharedVars.get('language_code');
  var langFile = path.join(__dirname, 'i18n', 'strings_' + (langCode || 'en') + '.json');
  var defaultFile = path.join(__dirname, 'i18n', 'strings_en.json');
  var uiconfFile = path.join(__dirname, 'UIConfig.json');

  self.commandRouter.i18nJson(langFile, defaultFile, uiconfFile)
    .then(function (uiconf) {
      self._populateUIConfig(uiconf);
      defer.resolve(uiconf);
    })
    .fail(function () {
      try {
        var raw = JSON.parse(fs.readFileSync(uiconfFile, 'utf8'));
        self._populateUIConfig(raw);
        defer.resolve(raw);
      } catch (e) {
        defer.reject(new Error('Could not load settings'));
      }
    });

  return defer.promise;
};

ControllerRecentlyAdded.prototype._populateUIConfig = function (uiconf) {
  try {
    // Section 0: Display
    var disp = uiconf.sections[0];
    var viewMode = this._getStr('view_mode', 'both');
    disp.content[0].value = this._findSelectValue(disp.content[0], viewMode);

    // Section 1: Connection
    var conn = uiconf.sections[1];
    conn.content[0].value = this._getStr('mpd_host', 'localhost');
    conn.content[1].value = this._getInt('mpd_port', 6600);
    conn.content[2].value = this._getInt('query_timeout_ms', 10000);
  } catch (err) {
    this.logger.error('RecentlyAdded: UI populate error: ' + err.message);
  }
};

/**
 * Find the matching {value, label} pair for a select element's current value.
 * Uses the already-translated labels from i18nJson.  Lifted from
 * oled_display_ssd1309.
 */
ControllerRecentlyAdded.prototype._findSelectValue = function (element, value) {
  if (element && element.options) {
    for (var i = 0; i < element.options.length; i++) {
      if (element.options[i].value === value) {
        return { value: value, label: element.options[i].label };
      }
    }
  }
  return { value: value, label: value };
};

ControllerRecentlyAdded.prototype.saveConfig = function (data) {
  var self = this;

  self._persistToManagedConfig(data);
  self._reloadConfig();

  self.commandRouter.pushToastMessage('success', 'Recently Added',
    self._t('TOAST.RECONNECTING'));

  // Tear down and re-init the MPD client so new host/port take effect
  try {
    if (self.mpdClient) {
      self.mpdClient.disconnect();
      self.mpdClient = null;
    }
    self._startPlugin();
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    self.logger.error('RecentlyAdded: reconnect failed: ' + msg);
    self.commandRouter.pushToastMessage('error', 'Recently Added',
      self._t('TOAST.RECONNECT_FAILED', { message: msg }));
  }

  return libQ.resolve();
};

/**
 * Write config to the Volumio-managed config file, bypassing v-conf.
 * See oled_display_ssd1309 v1.7.17 for the rationale — v-conf's deferred
 * auto-save overwrites synchronous writes with stale values.
 */
ControllerRecentlyAdded.prototype._persistToManagedConfig = function (data) {
  try {
    var managedPath = this.commandRouter.pluginManager.getConfigurationFile(
      this.context, 'config.json'
    );

    var keyTypes = {
      'mpd_host': 'string',
      'mpd_port': 'number',
      'query_timeout_ms': 'number',
      'view_mode': 'string'
    };

    // Start from whatever's on disk so we preserve keys not in this save.
    var raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(managedPath, 'utf8'));
    } catch (_) {
      try {
        raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      } catch (_2) {
        raw = {};
      }
    }

    // Unwrap any v-conf {type, value} entries to plain values for merging
    var snapshot = {};
    var rawKeys = Object.keys(raw);
    for (var k = 0; k < rawKeys.length; k++) {
      var val = raw[rawKeys[k]];
      if (val && typeof val === 'object' && val.value !== undefined && val.type) {
        snapshot[rawKeys[k]] = val.value;
      } else {
        snapshot[rawKeys[k]] = val;
      }
    }

    if (data.mpd_host !== undefined) snapshot.mpd_host = String(data.mpd_host);
    if (data.mpd_port !== undefined) snapshot.mpd_port = parseInt(data.mpd_port, 10);
    if (data.query_timeout_ms !== undefined) {
      snapshot.query_timeout_ms = parseInt(data.query_timeout_ms, 10);
    }
    // Select element: UI sends { value, label } — extract the value
    if (data.view_mode !== undefined) {
      snapshot.view_mode = (typeof data.view_mode === 'object' && data.view_mode !== null)
        ? data.view_mode.value
        : String(data.view_mode);
    }

    // Re-wrap into v-conf format for writing
    var vconfData = {};
    var snapshotKeys = Object.keys(snapshot);
    for (var i = 0; i < snapshotKeys.length; i++) {
      var sKey = snapshotKeys[i];
      var sVal = snapshot[sKey];
      var sType = keyTypes[sKey] || (typeof sVal);
      vconfData[sKey] = { type: sType, value: sVal };
    }

    var dir = path.dirname(managedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(managedPath, JSON.stringify(vconfData, null, 2), 'utf8');
    this.logger.info('RecentlyAdded: config persisted to ' + managedPath);
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    this.logger.error('RecentlyAdded: failed to persist config: ' + msg);
    try {
      this.commandRouter.pushToastMessage('error', 'Recently Added',
        this._t('TOAST.SAVE_FAILED', { message: msg }));
    } catch (_) { }
  }
};


// ═══════════════════════════════════════════════════════════════════════════
// Browse source registration & navigation
// ═══════════════════════════════════════════════════════════════════════════

ControllerRecentlyAdded.prototype._addToBrowseSources = function () {
  var self = this;

  // Diagnostic: confirm the icon file is on disk where Volumio's
  // albumart.js will look for it (/data/plugins/<type>/<name>/icon.png).
  var iconAbs = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconAbs)) {
    self.logger.info('RecentlyAdded: icon present at ' + iconAbs);
  } else {
    self.logger.error('RecentlyAdded: icon.png MISSING at ' + iconAbs);
  }

  // Cache-bust with version: browsers/Volumio cache /albumart responses
  // aggressively, so the URL needs to differ between releases.
  var data = {
    name: self._t('BROWSE.ROOT_TITLE'),
    uri: PLUGIN_URI,
    plugin_type: 'music_service',
    plugin_name: 'recently_added',
    albumart: '/albumart?sourceicon=music_service/recently_added/icon.png&v=' +
              encodeURIComponent(PKG_VERSION)
  };
  self.commandRouter.volumioAddToBrowseSources(data);
};

/**
 * Browse handler.  URIs we serve:
 *   recently_added                       → list of time-window folders
 *   recently_added/window/<n>d           → albums (and/or artists) in window
 *   recently_added/window/<n>d/artist/X  → single artist's recent albums
 *
 * Album navigation forwards via 'music-library/...' URIs handled by MPD.
 */
ControllerRecentlyAdded.prototype.handleBrowseUri = function (curUri) {
  var self = this;
  var defer = libQ.defer();

  // M8: was INFO, dropped to debug — every nav tap shouldn't spam logs.
  if (typeof self.logger.debug === 'function') {
    self.logger.debug('RecentlyAdded: handleBrowseUri ' + curUri);
  }

  try {
    if (curUri === PLUGIN_URI) {
      defer.resolve(self._buildRootList());
      return defer.promise;
    }

    // Artist drill-down: recently_added/window/<n>d/artist/<encoded-name>
    var artistMatch = curUri.match(/^recently_added\/window\/(\d+)d\/artist\/(.+)$/);
    if (artistMatch) {
      var aDays = parseInt(artistMatch[1], 10);
      var artistName = decodeURIComponent(artistMatch[2]);
      self._buildArtistAlbums(aDays, artistName)
        .then(function (response) { defer.resolve(response); })
        .catch(function (err) {
          self.logger.error('RecentlyAdded: artist build failed: ' + err.message);
          defer.resolve(self._errorWindow(aDays));
        });
      return defer.promise;
    }

    // Window: recently_added/window/<n>d
    var winMatch = curUri.match(/^recently_added\/window\/(\d+)d$/);
    if (winMatch) {
      var days = parseInt(winMatch[1], 10);
      self._buildWindowList(days)
        .then(function (response) { defer.resolve(response); })
        .catch(function (err) {
          self.logger.error('RecentlyAdded: window build failed: ' + err.message);
          defer.resolve(self._errorWindow(days));
        });
      return defer.promise;
    }

    self.logger.warn('RecentlyAdded: unknown URI, returning empty: ' + curUri);
    defer.resolve({ navigation: { lists: [] } });
  } catch (err) {
    self.logger.error('RecentlyAdded: browse error: ' + err.message);
    defer.reject(err);
  }

  return defer.promise;
};

ControllerRecentlyAdded.prototype._buildRootList = function () {
  var self = this;
  var windows = [
    { days: 7  },
    { days: 14 },
    { days: 30 },
    { days: 90 }
  ];

  var items = windows.map(function (w) {
    return {
      service: 'recently_added',
      type: 'folder',
      title: self._windowTitle(w.days),                 // M6
      icon: SECTION_ICON,
      uri: PLUGIN_URI + '/window/' + w.days + 'd'
    };
  });

  return {
    navigation: {
      prev: { uri: '' },
      lists: [{
        title: self._t('BROWSE.ROOT_TITLE'),
        icon: SECTION_ICON,
        availableListViews: LIST_VIEWS,
        items: items
      }]
    }
  };
};

/**
 * Query MPD for files modified in the last `days` days, then return one
 * or two sections (Albums / Artists) per the user's view_mode setting.
 *
 * Returns a native Promise — wrapped into kew at the call site.
 */
ControllerRecentlyAdded.prototype._buildWindowList = function (days) {
  var self = this;

  if (!self.mpdClient) {
    return Promise.reject(new Error('MPD client not initialized'));
  }

  var sinceDate = new Date(Date.now() - days * DAY_MS);
  var viewMode = self._getStr('view_mode', 'both');

  return self.mpdClient.findModifiedSince(sinceDate).then(function (entries) {
    if (typeof self.logger.debug === 'function') {
      self.logger.debug('RecentlyAdded: MPD returned ' + entries.length +
        ' files since ' + sinceDate.toISOString() + ' view=' + viewMode);
    }

    var lists = [];
    if (viewMode === 'albums' || viewMode === 'both') {
      lists.push(self._albumsSection(days, entries));
    }
    if (viewMode === 'artists' || viewMode === 'both') {
      lists.push(self._artistsSection(days, entries));
    }

    return {
      navigation: {
        prev: { uri: PLUGIN_URI },
        lists: lists
      }
    };
  });
};

/**
 * Drill-down into a single artist's recently-added albums.  Re-queries
 * MPD (cheap), filters to entries whose AlbumArtist (or Artist fallback)
 * matches the requested name, and returns the album-grouped view.
 */
ControllerRecentlyAdded.prototype._buildArtistAlbums = function (days, artistName) {
  var self = this;

  if (!self.mpdClient) {
    return Promise.reject(new Error('MPD client not initialized'));
  }

  var sinceDate = new Date(Date.now() - days * DAY_MS);

  return self.mpdClient.findModifiedSince(sinceDate).then(function (entries) {
    var filtered = entries.filter(function (e) {
      return grouping.artistOf(e) === artistName;
    });
    if (typeof self.logger.debug === 'function') {
      self.logger.debug('RecentlyAdded: ' + filtered.length +
        ' track(s) for "' + artistName + '" in last ' + days + ' days');
    }

    var albums = grouping.groupByAlbum(filtered);
    var items = albums.map(function (a) { return self._albumItem(a); });

    return {
      navigation: {
        prev: { uri: PLUGIN_URI + '/window/' + days + 'd' },
        lists: [{
          title: self._t('BROWSE.ARTIST_HEADER', {
            artist: artistName,
            window: self._windowTitle(days),
            count: self._countLabel('BROWSE.ALBUM_COUNT', items.length)
          }),
          icon: ALBUMS_ICON,
          availableListViews: LIST_VIEWS,
          items: items
        }]
      }
    };
  });
};

/**
 * Build the "Albums" section: group entries by parent directory, sort by
 * most-recent-modification descending.
 */
ControllerRecentlyAdded.prototype._albumsSection = function (days, entries) {
  var self = this;
  var albums = grouping.groupByAlbum(entries);
  var items = albums.map(function (a) { return self._albumItem(a); });

  return {
    title: self._t('BROWSE.ALBUMS_HEADER', {
      window: self._windowTitle(days),
      count: self._countLabel('BROWSE.ALBUM_COUNT', items.length)
    }),
    icon: ALBUMS_ICON,
    availableListViews: LIST_VIEWS,
    items: items
  };
};

/**
 * Build the "Artists" section: group by AlbumArtist (fallback Artist),
 * with each artist linking to a filtered drill-down view.  Album art
 * for the artist tile uses the most recent album folder of that artist —
 * a real cover is more recognisable than a generic user icon.
 */
ControllerRecentlyAdded.prototype._artistsSection = function (days, entries) {
  var self = this;

  var artistMap = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.file) continue;

    var artist = grouping.artistOf(e);
    var modified = e['Last-Modified'] ? new Date(e['Last-Modified']).getTime() : 0;
    var albumPath = e.file.split('/').slice(0, -1).join('/');

    if (!artistMap[artist]) {
      artistMap[artist] = {
        name: artist,
        modified: modified,
        recentAlbumPath: albumPath,
        recentAlbumModified: modified
      };
    } else {
      var a = artistMap[artist];
      if (modified > a.modified) a.modified = modified;
      if (modified > a.recentAlbumModified) {
        a.recentAlbumPath = albumPath;
        a.recentAlbumModified = modified;
      }
    }
  }

  var artists = Object.keys(artistMap).map(function (k) { return artistMap[k]; });
  artists.sort(function (a, b) { return b.modified - a.modified; });

  var items = artists.map(function (a) {
    var item = {
      service: 'recently_added',
      type: 'folder',
      // The "Unknown Artist" sentinel from grouping.artistOf is mapped
      // to its localized label here (display-side only — grouping still
      // uses the canonical English string as the bucket key).
      title: a.name === 'Unknown Artist' ? self._t('BROWSE.UNKNOWN_ARTIST') : a.name,
      uri: PLUGIN_URI + '/window/' + days + 'd/artist/' + encodeURIComponent(a.name)
    };
    if (a.recentAlbumPath) {
      // icon=user is the fallback shown by Volumio's albumart server if
      // no actual artwork is found at the given path; metadata=false skips
      // ID3 reading (we just want the folder cover, not embedded art).
      item.albumart = '/albumart?path=' +
        encodeURIComponent(self._mpdRelativeToAbsolute(a.recentAlbumPath)) +
        '&icon=user&metadata=false';
    } else {
      item.icon = ARTISTS_ICON;
    }
    return item;
  });

  return {
    title: self._t('BROWSE.ARTISTS_HEADER', {
      window: self._windowTitle(days),
      count: self._countLabel('BROWSE.ARTIST_COUNT', items.length)
    }),
    icon: ARTISTS_ICON,
    availableListViews: LIST_VIEWS,
    items: items
  };
};

/**
 * Construct a single Volumio browse item for an album bucket.
 * Forwards to MPD's `music-library/...` URI, which Volumio's MPD
 * controller handles natively.
 *
 * Title prefers the Album tag (M4) and falls back to the folder name
 * when no track in the bucket has an Album tag.
 *
 * The `artist` field becomes the dimmer secondary column on the row in
 * Volumio's list view (matching the stock Albums view).  We resolve it
 * via grouping.albumArtistOf().  The 'Various Artists' sentinel is
 * displayed verbatim — Volumio's stock Albums view does the same, and
 * "Various Artists" is a quasi-proper-noun in music tagging conventions
 * (iTunes, MusicBrainz, etc.) that's typically left untranslated even
 * in non-English UIs.  Localizing it would create cross-tile
 * inconsistency without meaningful benefit.
 *
 * Omitted entirely when no meaningful artist info is present, so rows
 * for genuinely-untagged albums don't carry a stray empty column.
 */
ControllerRecentlyAdded.prototype._albumItem = function (album) {
  var folderName = album.path.split('/').pop();
  var entries = album.entries || [];
  var title = grouping.albumTitleOf(entries, folderName);
  var artist = grouping.albumArtistOf(entries);  // string or null

  var item = {
    service: 'mpd',
    type: 'folder',
    title: title,
    uri: 'music-library/' + album.path,
    // L6: icon=folder-o is the fallback if no artwork; metadata=false
    // skips embedded-tag art lookup (we want the folder cover image).
    albumart: '/albumart?path=' +
              encodeURIComponent(this._mpdRelativeToAbsolute(album.path)) +
              '&icon=folder-o&metadata=false'
  };
  if (artist) item.artist = artist;
  return item;
};

/**
 * Render an "MPD unreachable" page when a query fails.  H5 + H6: shows
 * a single non-clickable status line with a clean localized message,
 * not the raw error.
 */
ControllerRecentlyAdded.prototype._errorWindow = function (days) {
  return {
    navigation: {
      prev: { uri: PLUGIN_URI },
      lists: [{
        title: this._t('BROWSE.ERROR_TITLE', {
          window: this._windowTitle(days)
        }),
        icon: ERROR_ICON,
        availableListViews: ['list'],
        items: [{
          // 'item-no-menu' suppresses the burger menu (no Play / Add to
          // Queue) since this is a status message, not a playable item.
          // No `uri` field means tapping does nothing — we don't want
          // the user bouncing into a loop on a broken connection.
          service: 'recently_added',
          type: 'item-no-menu',
          title: this._t('BROWSE.MPD_UNREACHABLE'),
          icon: ERROR_ICON
        }]
      }]
    }
  };
};

/**
 * Translate an MPD-relative path to an absolute filesystem path for
 * use in albumart URLs.  Volumio's MPD has its music_directory at
 * /var/lib/mpd/music with symlinks for INTERNAL/USB/NAS, but the
 * albumart server expects the resolved mount path.
 *
 * Defaults match Volumio's stock layout.  M3 (dynamic discovery from
 * /var/lib/mpd/music symlinks) is deferred — only matters for
 * non-standard mountpoints.
 */
ControllerRecentlyAdded.prototype._mpdRelativeToAbsolute = function (mpdRel) {
  for (var i = 0; i < MPD_PATH_MAPPINGS.length; i++) {
    var m = MPD_PATH_MAPPINGS[i];
    if (mpdRel.indexOf(m.prefix) === 0) {
      return m.replacement + mpdRel.substring(m.prefix.length);
    }
  }
  // Unknown prefix — fall back to MPD's mount root
  return '/var/lib/mpd/music/' + mpdRel;
};

/**
 * Required by the music_service plugin contract.  Returns empty because
 * we never own playable URIs — every track we surface is forwarded to
 * MPD via `music-library/...` URIs handled by MPD's own controller.
 * If this is ever called on one of our URIs, it indicates a routing
 * bug elsewhere; we log a warning but return cleanly.  (M9)
 */
ControllerRecentlyAdded.prototype.explodeUri = function (uri) {
  if (uri && uri.indexOf(PLUGIN_URI + '/') === 0) {
    this.logger.warn('RecentlyAdded: explodeUri called on browse URI ' + uri);
  }
  return libQ.resolve([]);
};

/**
 * Required by the music_service plugin contract.  We deliberately don't
 * participate in global search today — the plugin is a time-windowed
 * view, not a search source.  A future enhancement could overlay our
 * window filter on top of MPD search results.  (M10)
 */
ControllerRecentlyAdded.prototype.search = function (query) {
  return libQ.resolve([]);
};
