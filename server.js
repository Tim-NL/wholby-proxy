const fs = require('fs');
const { createHash } = require('crypto');
const path = require('path');
const express = require('express');
const { createProxyMiddleware, responseInterceptor, fixRequestBody } = require('http-proxy-middleware');

const app = express();

// --- Configuration ---
// Replace with your actual Emby server URL and Port, or pass via environment variable
const normalizeEmbyUrl = (value) => String(value || '').trim().replace(/\/+$/, '');
const PORT = parseInt(process.env.PORT, 10) || 8096;
// Bind address. Use 127.0.0.1 when a reverse proxy (nginx) sits in front.
const HOST = process.env.HOST || '0.0.0.0';
// Settings that can be changed while the proxy runs (from the admin dashboard). Defaults come from the environment;
// values saved from the dashboard (data/settings.json) override them at startup.
//   embyUrl: the Emby server this proxy talks to. Changing it from the dashboard signs everyone out.
//   streamMode: "auto" redirects the client straight to Emby when client and the Emby address share a protocol (players refuse
//     an http -> https redirect), otherwise pipes the stream through this proxy. "redirect" always redirects (no proxy
//     bandwidth; Emby must be reachable by the client). "proxy" always pipes streams through this proxy.
//   directPlayOnly: Wholphin clients only direct play: PlaybackInfo always reports direct play and transcode requests
//     are refused, so Emby never spends CPU transcoding for them.
//   reportedVersion: Jellyfin version shown to clients. Wholphin refuses servers older than its SDK's minimum.
//   resumeFetchLimit: Emby merges "Next Up" into "Continue Watching". We fetch this many, then split and trim per request.
const settings = {
    embyUrl: normalizeEmbyUrl(process.env.EMBY_URL || 'http://YOUR_EMBY_IP:8096'),
    streamMode: (process.env.STREAM_MODE || 'auto').toLowerCase(),
    directPlayOnly: (process.env.DIRECT_PLAY_ONLY || 'true').toLowerCase() !== 'false',
    reportedVersion: process.env.REPORTED_VERSION || '10.10.7',
    resumeFetchLimit: parseInt(process.env.RESUME_FETCH_LIMIT, 10) || 100,
    debug: process.env.DEBUG === 'true',
};

// Accepts only a plain http(s) address such as http://192.168.1.100:8096 or https://emby.example.com.
const parseEmbyUrl = (raw) => {
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 300) return { ok: false, error: 'Enter the Emby server address, for example http://192.168.1.100:8096.' };
    let u;
    try { u = new URL(raw.trim()); } catch { return { ok: false, error: 'That does not look like a web address. Start it with http:// or https://.' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://.' };
    if (u.username || u.password) return { ok: false, error: 'Leave the username and password out of the address.' };
    if (u.search || u.hash) return { ok: false, error: 'Use only the server address, without a ? or # part.' };
    if (!u.hostname || /your_emby_ip/i.test(u.hostname)) return { ok: false, error: 'Enter the real address of your Emby server.' };
    return { ok: true, url: normalizeEmbyUrl(u.origin + u.pathname) };
};

// Checks a partial settings object. Returns { ok: true, value } with cleaned values or { ok: false, errors }.
const validateSettings = (patch) => {
    const errors = [];
    const value = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['Settings must be an object.'] };
    for (const [key, v] of Object.entries(patch)) {
        switch (key) {
            case 'embyUrl': {
                const parsed = parseEmbyUrl(v);
                if (parsed.ok) value.embyUrl = parsed.url;
                else errors.push(parsed.error);
                break;
            }
            case 'streamMode':
                if (['auto', 'redirect', 'proxy'].includes(v)) value.streamMode = v;
                else errors.push('streamMode must be auto, redirect or proxy.');
                break;
            case 'directPlayOnly':
            case 'debug':
                if (typeof v === 'boolean') value[key] = v;
                else errors.push(`${key} must be true or false.`);
                break;
            case 'reportedVersion':
                if (typeof v === 'string' && /^\d{1,2}\.\d{1,3}\.\d{1,3}$/.test(v)) value.reportedVersion = v;
                else errors.push('reportedVersion must look like 10.10.7.');
                break;
            case 'resumeFetchLimit':
                if (Number.isInteger(v) && v >= 10 && v <= 500) value.resumeFetchLimit = v;
                else errors.push('resumeFetchLimit must be a whole number from 10 to 500.');
                break;
            default:
                errors.push(`Unknown setting: ${key}.`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, value };
};


// Generate a unique UUID for your proxy instance, or pass via environment variable
const PROXY_SERVER_ID = process.env.PROXY_SERVER_ID || "YOUR_UNIQUE_UUID_HERE";  

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// token -> Emby user id. Bounded so a long-running proxy cannot grow without limit.
const MAX_TOKENS = 5000;
const tokenToUserId = new Map();
// Persisted so clients with saved sessions keep working after a proxy restart (mount a volume at this path in Docker).
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, 'data', 'tokens.json');
let saveTimer = null;
const saveTokens = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
            const tmp = `${TOKEN_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify([...tokenToUserId]), { mode: 0o600 });
            fs.renameSync(tmp, TOKEN_FILE);
        } catch (err) {
            console.error('[Token Store] could not save:', err.message);
        }
    }, 2000);
    saveTimer.unref();
};
const loadTokens = () => {
    try {
        for (const [token, uid] of JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))) tokenToUserId.set(token, uid);
        console.log(`[Token Store] restored ${tokenToUserId.size} session(s)`);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[Token Store] could not load:', err.message);
    }
};
const setToken = (token, uid) => {
    if (!token || !uid) return;
    if (tokenToUserId.get(token) === uid) return;
    tokenToUserId.delete(token);
    tokenToUserId.set(token, uid);
    if (tokenToUserId.size > MAX_TOKENS) tokenToUserId.delete(tokenToUserId.keys().next().value);
    saveTokens();
};

// --- Settings file (written by the admin dashboard) ---
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(path.dirname(process.env.TOKEN_FILE || path.join(__dirname, 'data', 'tokens.json')), 'settings.json');
const applySettings = (patch, { persist = true } = {}) => {
    const result = validateSettings(patch);
    if (!result.ok) return result;
    const embyChanged = Boolean(result.value.embyUrl) && result.value.embyUrl !== settings.embyUrl;
    Object.assign(settings, result.value);
    if (persist && embyChanged) {
        // Saved logins, play sessions and cached filters belong to the previous Emby server.
        tokenToUserId.clear();
        playSessionToken.clear();
        deviceToken.clear();
        filterCache.clear();
        saveTokens();
    }
    if (persist) {
        try {
            let saved = {};
            try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* first save */ }
            fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
            const tmp = `${SETTINGS_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ ...saved, ...result.value }, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, SETTINGS_FILE);
        } catch (err) {
            return { ok: false, errors: [`Settings applied but could not be saved: ${err.message}`] };
        }
    }
    return result;
};
const loadSettings = () => {
    try {
        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const result = applySettings(saved, { persist: false });
        if (!result.ok) console.error('[Settings] ignored invalid saved settings:', result.errors.join(' '));
        else console.log(`[Settings] loaded ${Object.keys(result.value).length} saved setting(s) from ${SETTINGS_FILE}`);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[Settings] could not load:', err.message);
    }
};

// --- Counters and recent errors, shown in the admin dashboard ---
const stats = {
    startedAt: Date.now(),
    requests: 0,
    status: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 },
    embyErrors: 0,
    perMinute: new Map(), // minute number -> request count, last 60 minutes kept
};
const recentErrors = [];
const MAX_RECENT_ERRORS = 200;
const noteError = (text) => {
    recentErrors.push({ at: Date.now(), text: redact(String(text)).slice(0, 400) });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
};
const countRequest = (res) => {
    stats.requests += 1;
    const minute = Math.floor(Date.now() / 60000);
    stats.perMinute.set(minute, (stats.perMinute.get(minute) || 0) + 1);
    for (const m of stats.perMinute.keys()) if (m < minute - 60) stats.perMinute.delete(m);
    res.on('finish', () => {
        const c = Math.floor(res.statusCode / 100);
        if (c >= 2 && c <= 5) stats.status[`s${c}xx`] += 1;
    });
};

// PlaySessionId -> access token. Wholphin fetches direct-play streams with a plain HTTP client that sends no
// credentials (Jellyfin serves those anonymously, Emby answers 401), so we attach the session owner's token.
const MAX_PLAY_SESSIONS = 2000;
const playSessionToken = new Map();
const deviceToken = new Map();
const rememberPlaySession = (playSessionId, token) => {
    if (!playSessionId || !token) return;
    playSessionToken.delete(playSessionId);
    playSessionToken.set(playSessionId, token);
    if (playSessionToken.size > MAX_PLAY_SESSIONS) playSessionToken.delete(playSessionToken.keys().next().value);
};

const tokenFromRequest = (rawUrl, headers) => {
    const authHeader = headers['x-emby-authorization'] || headers['authorization'] || '';
    const m = authHeader.match(/Token="([^"]+)"/i);
    if (m) return m[1];
    if (headers['x-emby-token'] || headers['x-mediabrowser-token']) return headers['x-emby-token'] || headers['x-mediabrowser-token'];
    const qp = new URL(rawUrl, 'http://localhost').searchParams;
    return qp.get('api_key') || qp.get('ApiKey') || qp.get('Token') || qp.get('token') || null;
};

// For a request that carries no credentials, find the token that owns its PlaySessionId.
const resolveStreamToken = (rawUrl, headers) => {
    if (tokenFromRequest(rawUrl, headers)) return null;
    const qp = new URL(rawUrl, 'http://localhost').searchParams;
    for (const [k, v] of qp) if (k.toLowerCase() === 'playsessionid' && playSessionToken.has(v)) return playSessionToken.get(v);
    for (const [k, v] of qp) if (k.toLowerCase() === 'deviceid' && deviceToken.has(v)) return deviceToken.get(v);
    return null;
};

// Request side: ask Emby for a direct-play answer and never a transcode.
const forceDirectPlayRequest = (body) => {
    if (!body || typeof body !== 'object') return body;
    body.EnableDirectPlay = true;
    body.EnableDirectStream = true;
    body.EnableTranscoding = false;
    body.AllowVideoStreamCopy = true;
    body.AllowAudioStreamCopy = true;
    delete body.MaxStreamingBitrate;
    return body;
};

// Response side: whatever Emby decided, report every source as directly playable and drop transcode URLs.
const forceDirectPlayResponse = (data) => {
    if (!data || !Array.isArray(data.MediaSources)) return data;
    for (const ms of data.MediaSources) {
        if (!ms) continue;
        ms.SupportsDirectPlay = true;
        ms.SupportsDirectStream = true;
        ms.SupportsTranscoding = false;
        delete ms.TranscodingUrl;
        delete ms.TranscodingSubProtocol;
        delete ms.TranscodingContainer;
    }
    return data;
};

// Wholphin plays music and theme songs through /Audio/<id>/universal, which transcodes when the file's container is not in
// the client's list. In direct-play-only mode serve the raw file instead (static stream).
const KEEP_FOR_STATIC_AUDIO = new Set(['api_key', 'apikey', 'token', 'userid', 'deviceid', 'playsessionid', 'mediasourceid', 'tag']);
const rewriteUniversalAudio = (rawUrl) => {
    const [base, query = ''] = rawUrl.split(/\?(.*)/s);
    const m = base.match(/^(\/(?:emby\/)?Audio\/[^/]+)\/universal$/i);
    if (!m) return null;
    const qp = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(query)) if (KEEP_FOR_STATIC_AUDIO.has(k.toLowerCase())) qp.append(k, v);
    qp.set('static', 'true');
    return `${m[1]}/stream?${qp.toString()}`;
};

// DeviceId -> access token, learned from authenticated requests, for streams fetched by clients that send no credentials.
const rememberDevice = (headers) => {
    const h = headers['x-emby-authorization'] || headers['authorization'] || '';
    const token = (h.match(/Token="([^"]+)"/i) || [])[1];
    const device = (h.match(/DeviceId="([^"]+)"/i) || [])[1];
    if (!token || !device) return;
    deviceToken.delete(device);
    deviceToken.set(device, token);
    if (deviceToken.size > MAX_PLAY_SESSIONS) deviceToken.delete(deviceToken.keys().next().value);
};

// Requests that would make Emby transcode: HLS playlists/segments, and video streams that are not static.
const isTranscodeRequest = (rawUrl) => {
    const [base, query = ''] = rawUrl.split(/\?(.*)/s);
    if (/\/(master|main|live)\.m3u8$/i.test(base) || /\/hls1?\//i.test(base)) return true;
    if (/^\/(emby\/)?(Videos|Audio)\/[^/]+\/(stream|universal)(\.[a-z0-9]+)?$/i.test(base)) {
        const isStatic = [...new URLSearchParams(query)].some(([k, v]) => k.toLowerCase() === 'static' && v.toLowerCase() === 'true');
        return !isStatic;
    }
    return false;
};

// Never log credentials that travel in the query string.
const redact = (url) => String(url).replace(/([?&](?:api_key|apikey|token|accesstoken)=)[^&]*/ig, '$1***');

// --- Express Body Parser ---
app.use((req, res, next) => { countRequest(res); next(); });
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Debug Logger ---
app.use((req, res, next) => {
    if (settings.debug) {
        console.log(`[DEBUG] Incoming Request: ${req.method} ${redact(req.url)}`);
        if (/\/stream/i.test(req.url)) console.log(`[DEBUG]   headers: ${Object.keys(req.headers).join(", ")} ua=${req.headers["user-agent"]}`);
    }
    next();
});

// --- 1. Bijective UUID Generator ---
const toUUID = (id) => {
    if (!id) return "00000000-0000-0000-0000-000000000000";
    const s = String(id).replace(/-/g, '').toLowerCase();

    // Emby ids such as "mediasource_364241" are not numeric; leave them alone so they survive the round trip.
    if (/[^0-9a-f]/.test(s)) return String(id);

    if (s.length === 32) {
        return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
    }

    const padded = s.padStart(32, '0'); // Pad with zeros
    const prefixed = 'ffffffff' + padded.slice(8);
    return `${prefixed.slice(0,8)}-${prefixed.slice(8,12)}-${prefixed.slice(12,16)}-${prefixed.slice(16,20)}-${prefixed.slice(20)}`;
};

// --- 2. The Jellyfin Bubble Wrappers ---
const patchUser = (user) => {
    if (!user) return user;
    
    const imgTags = user.ImageTags || {};
    const effectiveTag = user.PrimaryImageTag || user.ImageTag || imgTags.Primary;

    if (effectiveTag) {
        imgTags.Primary = effectiveTag;
        user.PrimaryImageTag = effectiveTag;
        user.HasPrimaryImage = true;
    } else {
        user.HasPrimaryImage = false;
    }

    const patched = {
        ...user,
        Id: toUUID(user.Id),
        ServerId: PROXY_SERVER_ID,
        ImageTags: imgTags,
        HasConfiguredEasyPassword: user.HasConfiguredEasyPassword || false,
        HasConfiguredPassword: user.HasConfiguredPassword || false,
        Configuration: {
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: "eng",
            DisplayMissingEpisodes: false,
            GroupedFolders: [],
            OrderedViews: [],
            LatestItemsExcludes: [],
            MyMediaExcludes: [],
            HidePlayedInLatest: true,
            SubtitleMode: "Default",
            DisplayCollectionsView: false,
            EnableLocalPassword: false,
            RememberAudioSelections: true,
            RememberSubtitleSelections: true,
            EnableNextEpisodeAutoPlay: true,
            ...(user.Configuration || {})
        },
        Policy: {
            IsAdministrator: user.Policy?.IsAdministrator || false,
            IsHidden: false,
            IsDisabled: false,
            BlockedTags: [],
            EnableUserPreferenceAccess: true,
            AccessSchedules: [],
            BlockUnratedItems: [],
            EnableRemoteControlOfOtherUsers: false,
            EnableSharedDeviceControl: true,
            EnableRemoteAccess: true,
            EnableLiveTvManagement: false,
            EnableLiveTvAccess: false,
            EnableMediaPlayback: true,
            EnableAudioPlaybackTranscoding: true,
            EnableVideoPlaybackTranscoding: true,
            EnablePlaybackRemuxing: true,
            ForceRemoteSourceTranscoding: false,
            EnableContentDeletion: false,
            EnableContentDeletionFromFolders: [],
            EnableContentDownloading: false,
            EnableSyncTranscoding: false,
            EnableMediaConversion: false,
            EnabledDevices: [],
            EnableAllDevices: true,
            EnabledChannels: [],
            EnableAllChannels: true,
            EnabledFolders: [],
            EnableAllFolders: true,
            InvalidLoginAttemptCount: 0,
            LoginAttemptsBeforeLockout: 15,
            MaxActiveSessions: 0,
            EnablePublicSharing: false,
            BlockedMediaFolders: [],
            BlockedChannels: [],
            RemoteClientBitrateLimit: 0,
            AuthenticationProviderId: "Emby.Server.Implementations.Library.DefaultAuthenticationProvider",
            PasswordResetProviderId: "Emby.Server.Implementations.Library.DefaultPasswordResetProvider",
            SyncPlayAccess: "CreateAndJoinGroups",
            ...(user.Policy || {})
        }
    };
    // Folder and channel ids in the policy are typed UUIDs on the Jellyfin side.
    for (const key of ['EnabledFolders', 'BlockedMediaFolders', 'EnabledChannels', 'BlockedChannels', 'EnableContentDeletionFromFolders']) {
        if (Array.isArray(patched.Policy[key])) patched.Policy[key] = patched.Policy[key].map((id) => toUUID(id));
    }
    // Library ids in the configuration are typed UUIDs too; Emby fills them once a user reorders or hides libraries.
    for (const key of ['GroupedFolders', 'OrderedViews', 'LatestItemsExcludes', 'MyMediaExcludes']) {
        if (Array.isArray(patched.Configuration[key])) patched.Configuration[key] = patched.Configuration[key].map((id) => toUUID(id));
    }
    return patched;
};

const patchSessionInfo = (sessionInfo) => {
    if (!sessionInfo) return sessionInfo;
    return {
        ...sessionInfo,
        Id: toUUID(sessionInfo.Id),
        UserId: toUUID(sessionInfo.UserId),
        LastPlaybackCheckIn: sessionInfo.LastPlaybackCheckIn || "0001-01-01T00:00:00.0000000Z",
        IsActive: sessionInfo.IsActive !== undefined ? sessionInfo.IsActive : true,
        SupportsMediaControl: sessionInfo.SupportsMediaControl !== undefined ? sessionInfo.SupportsMediaControl : true,
        HasCustomDeviceName: sessionInfo.HasCustomDeviceName || false,
        ServerId: PROXY_SERVER_ID,
        PlayState: {
            PlaybackOrder: "Default",
            RepeatMode: "RepeatNone",
            ...(sessionInfo.PlayState || {})
        }
    };
};

// Emby answers favorite / played toggles with a bare user-data object that lacks the Key and ItemId Jellyfin clients require.
const USER_DATA_ROUTE = /^\/?(?:emby\/)?(?:UserFavoriteItems|UserPlayedItems|UserItems|Users\/[^/]+\/(?:FavoriteItems|PlayedItems|Items))\/([^/?]+)(?:\/UserData)?(?:\?|$)/i;
const normalizeUserData = (data, rawItemId) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    if (!('PlaybackPositionTicks' in data || 'Played' in data || 'IsFavorite' in data)) return data;
    data.PlayCount = data.PlayCount || 0;
    data.PlaybackPositionTicks = data.PlaybackPositionTicks || 0;
    data.IsFavorite = Boolean(data.IsFavorite);
    data.Played = data.Played !== undefined ? Boolean(data.Played) : data.PlayCount > 0;
    if (data.Played && !data.PlayCount) data.PlayCount = 1;
    data.Key = data.Key || String(rawItemId);
    data.ItemId = toUUID(data.ItemId || rawItemId);
    return data;
};

// --- 3. The Global Deep-Patcher ---
const deepPatch = (obj, parentId = "") => {
    if (!obj) return;

    if (Array.isArray(obj)) {
        obj.forEach(item => deepPatch(item, parentId));
        return;
    }

    if (typeof obj === 'object' && obj !== null) {
        
        if (obj.Items && Array.isArray(obj.Items)) {
            obj.StartIndex = parseInt(obj.StartIndex) || 0;
            obj.TotalRecordCount = obj.TotalRecordCount !== undefined ? parseInt(obj.TotalRecordCount) : obj.Items.length;
        }

        const currentId = obj.Id ? String(obj.Id) : parentId;

        if (obj.Id || obj.ItemId) {
            obj.ServerId = PROXY_SERVER_ID;
            if (!obj.ImageTags) obj.ImageTags = {};
            if (!obj.BackdropImageTags) obj.BackdropImageTags = [];
            if (!obj.ProviderIds) obj.ProviderIds = {};
            if (!obj.ImageBlurHashes) obj.ImageBlurHashes = {}; 
            if (!obj.LocationType) obj.LocationType = "FileSystem";
            if (!obj.SourceType) obj.SourceType = "Local";
            if (!obj.PlayAccess) obj.PlayAccess = "Full";
            
            if (obj.PrimaryImageTag && !obj.ImageTags.Primary) {
                obj.ImageTags.Primary = obj.PrimaryImageTag;
                obj.HasPrimaryImage = true;
            }

            if (obj.Type) {
                const folderTypes = ["Folder", "CollectionFolder", "UserView", "BoxSet", "Series", "Season", "MusicAlbum", "MusicArtist", "Playlist", "Genre", "Studio", "Person"];
                obj.IsFolder = (obj.IsFolder === true || folderTypes.includes(obj.Type));
            }
        }

        if (Array.isArray(obj.MediaSources)) {
            obj.MediaSources.forEach(ms => {
                if (ms) {
                    ms.Id = toUUID(ms.Id || currentId);
                    ms.ServerId = PROXY_SERVER_ID;
                    ms.IgnoreDts = ms.IgnoreDts || false;
                    ms.IgnoreIndex = ms.IgnoreIndex || false;
                    ms.GenPtsInput = ms.GenPtsInput || false;
                    ms.TranscodingSubProtocol = ms.TranscodingSubProtocol || "hls";
                    ms.HasSegments = ms.HasSegments || false;
                    ms.IsInfiniteStream = ms.IsInfiniteStream || false;
                    ms.RequiresOpening = ms.RequiresOpening || false;
                    ms.RequiresClosing = ms.RequiresClosing || false;
                    ms.RequiresLooping = ms.RequiresLooping || false;
                    ms.SupportsProbing = ms.SupportsProbing || false;
                    ms.SupportsDirectPlay = ms.SupportsDirectPlay !== undefined ? ms.SupportsDirectPlay : true;
                }
            });
        }

        // Emby-only stream type; Jellyfin's MediaStreamType enum has no "Attachment" and Wholphin's parser rejects the item.
        if (Array.isArray(obj.MediaStreams)) {
            obj.MediaStreams.forEach(st => {
                if (st && st.Type === 'Attachment') st.Type = 'Data';
            });
        }

        if (Array.isArray(obj.Chapters)) {
            obj.Chapters.forEach(ch => {
                if (ch) ch.ImageDateModified = ch.ImageDateModified || "0001-01-01T00:00:00.0000000Z";
            });
        }

        const embySpecificKeys = [
            'LockedFields', 'ThemeSongIds', 'ThemeVideoIds', 
            'Trickplay', 'LocalTrailerCount', 'AnimeSeriesIndex', 'PresentationUniqueKey',
            'SeriesPresentationUniqueKey', 'ExternalEtag', 'SyncPercent', 
            'PrimaryVersionId', 'TagItems', 'AudioAnnotations',
            'VideoAnnotations', 'CriticRatingSummary', 'CriticRating', 'LockData',
            'MarkerType', 'ChapterIndex'
        ];

        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            const val = obj[key];
            if (val === null) { delete obj[key]; continue; }
            if (embySpecificKeys.includes(key)) { delete obj[key]; continue; }
            if (val === undefined) continue;

            let needsUUID = false;
            if (key === 'Id' || key === 'ItemId' || key === 'UserId' || key === 'ParentId') {
                needsUUID = true;
            } else if (key.endsWith('Ids') && key !== 'ProviderIds') {
                needsUUID = true;
            } else if (key.endsWith('Id') && !['ServerId', 'ClientId', 'DeviceId', 'AuthenticationProviderId', 'PasswordResetProviderId', 'PlaySessionId', 'LiveStreamId'].includes(key)) {
                needsUUID = true;
            }

            if (needsUUID) {
                if (typeof val === 'string' || typeof val === 'number') {
                    obj[key] = toUUID(val);
                } else if (Array.isArray(val)) {
                    obj[key] = val.filter(v => v !== null).map(v => {
                        if (typeof v === 'string' || typeof v === 'number') return toUUID(v);
                        if (typeof v === 'object' && v !== null) deepPatch(v, currentId);
                        return v;
                    });
                } else if (typeof val === 'object') {
                    deepPatch(val, currentId);
                }
            } else if (typeof val === 'object') {
                deepPatch(val, currentId);
            }
        }

        const fixUserData = (u, fallbackId) => {
            if (u && typeof u === 'object') {
                u.PlayCount = u.PlayCount || 0;
                u.PlaybackPositionTicks = u.PlaybackPositionTicks || 0;
                u.Key = u.Key || fallbackId;
                u.ItemId = toUUID(u.ItemId || fallbackId);
                if (u.Played === undefined) u.Played = (u.PlayCount > 0);
                if (u.Played && !u.PlayCount) u.PlayCount = 1;
            }
        };
        if (obj.UserData) fixUserData(obj.UserData, currentId);
    }
};

// A query for Jellyfin-only item types (e.g. Wholphin's Live TV search) returns an empty result.
app.use((req, res, next) => {
    if (req.method === 'GET' && asksOnlyForJellyTypes(req.url)) {
        return res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
    next();
});

// Direct-play-only: music and theme songs use /Audio/<id>/universal; serve the raw file instead of transcoding.
app.use((req, res, next) => {
    rememberDevice(req.headers);
    if (settings.directPlayOnly && req.method === 'GET') {
        const rewritten = rewriteUniversalAudio(req.url);
        if (rewritten) req.url = req.originalUrl = rewritten; // http-proxy-middleware re-reads originalUrl
    }
    next();
});

// Direct-play-only: refuse anything that would start a transcode.
app.use((req, res, next) => {
    if (settings.directPlayOnly && req.method === 'GET' && isTranscodeRequest(req.url)) {
        return res.status(403).json({ message: 'Transcoding is disabled on this server; the file must be played directly.' });
    }
    next();
});

// Hardcoded mocks
app.get('/LiveTv/Recordings/Folders', (req, res) => res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
app.get('/MediaSegments/:itemId', (req, res) => res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
// Jellyfin's /Items/Filters (used for Wholphin's Parental Rating, Year and Decade filters) does not exist on Emby.
const filterCache = new Map();
app.get('/Items/Filters', async (req, res) => {
    try {
        const token = tokenFromRequest(req.url, req.headers);
        if (!token) return res.status(401).json({ message: 'Unauthorized' });
        const uidParam = req.query.userId || req.query.UserId;
        const userId = uidParam ? deflateUUID(String(uidParam)) : tokenToUserId.get(token);
        const qp = new URLSearchParams({ Recursive: 'true' });
        if (userId) qp.set('UserId', userId);
        if (req.query.parentId) qp.set('ParentId', deflateUUID(String(req.query.parentId)));
        const types = [].concat(req.query.includeItemTypes || []).join(',');
        if (types) qp.set('IncludeItemTypes', types);
        const cacheKey = `${token}:${qp.toString()}`;
        const hit = filterCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json(hit.value);
        const names = async (endpoint) => {
            const r = await fetch(`${settings.embyUrl}/emby/${endpoint}?${qp}`, { headers: { 'X-Emby-Token': token } });
            if (!r.ok) throw new Error(`${endpoint} -> ${r.status}`);
            return ((await r.json()).Items || []).map((i) => i.Name).filter(Boolean);
        };
        const [genres, ratings, years] = await Promise.all([names('Genres'), names('OfficialRatings'), names('Years')]);
        const value = {
            Genres: genres,
            Tags: [],
            OfficialRatings: ratings,
            Years: years.map(Number).filter((n) => Number.isInteger(n)),
        };
        filterCache.set(cacheKey, { at: Date.now(), value });
        if (filterCache.size > 200) filterCache.delete(filterCache.keys().next().value);
        res.json(value);
    } catch (err) {
        console.error('[Filters]', err.message);
        noteError(`[Filters] ${err.message}`);
        res.status(502).json({ message: 'Could not read filter options from Emby.' });
    }
});

app.get('/LiveTv/Info', (req, res) => res.json({ IsEnabled: false, EnabledUsers: [] }));

// --- Display preferences ---
// Wholphin stores its home-screen layout and "removed from Next Up" state here, and refuses a DTO that lacks the
// required fields. Emby's equivalent differs, so they are kept locally (per user, client and id) and persisted.
const DISPLAY_PREFS_FILE = process.env.DISPLAY_PREFS_FILE || path.join(path.dirname(TOKEN_FILE), 'displayprefs.json');
const displayPrefs = new Map();
let prefsTimer = null;
const savePrefs = () => {
    if (prefsTimer) return;
    prefsTimer = setTimeout(() => {
        prefsTimer = null;
        try {
            fs.mkdirSync(path.dirname(DISPLAY_PREFS_FILE), { recursive: true });
            const tmp = `${DISPLAY_PREFS_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify([...displayPrefs]), { mode: 0o600 });
            fs.renameSync(tmp, DISPLAY_PREFS_FILE);
        } catch (err) {
            console.error('[Display Prefs] could not save:', err.message);
        }
    }, 1000);
    prefsTimer.unref();
};
const loadPrefs = () => {
    try {
        for (const [key, value] of JSON.parse(fs.readFileSync(DISPLAY_PREFS_FILE, 'utf8'))) displayPrefs.set(key, value);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[Display Prefs] could not load:', err.message);
    }
};

const defaultDisplayPrefs = (id, client) => ({
    Id: id,
    RememberIndexing: false,
    PrimaryImageHeight: 250,
    PrimaryImageWidth: 250,
    CustomPrefs: {},
    ScrollDirection: 'Horizontal',
    ShowBackdrop: true,
    RememberSorting: false,
    SortOrder: 'Ascending',
    ShowSidebar: false,
    Client: client,
});

const prefsKey = (req) => {
    const uid = req.query.userId || req.query.UserId;
    return `${uid ? deflateUUID(String(uid)) : 'anon'}:${req.query.client || req.query.Client || 'unknown'}:${req.params.id}`;
};

app.get('/DisplayPreferences/:id', (req, res) => {
    const client = req.query.client || req.query.Client || 'Wholphin';
    const saved = displayPrefs.get(prefsKey(req)) || {};
    res.json({ ...defaultDisplayPrefs(req.params.id, client), ...saved, Id: req.params.id, Client: client });
});

app.post('/DisplayPreferences/:id', (req, res) => {
    if (req.body && typeof req.body === 'object') {
        displayPrefs.set(prefsKey(req), req.body);
        savePrefs();
    }
    res.status(204).send();
});
app.post(['/Sessions/Capabilities', '/emby/Sessions/Capabilities'], (req, res) => res.status(204).send());
app.post('/ClientLog/Document', (req, res) => res.status(200).send("Log ignored"));
app.get('/QuickConnect/Enabled', (req, res) => res.send("false")); 
app.get('/Branding/Configuration', (req, res) => res.json({ LoginDisclaimer: "", CustomHtml: "" }));

// --- 4. Passive State Recovery Sniffer ---
app.use((req, res, next) => {
    try {
        const urlObj = new URL(req.url, 'http://localhost');
        const uid = urlObj.searchParams.get('userId') || urlObj.searchParams.get('UserId');
        let token = "";
        const authHeader = req.headers['x-emby-authorization'] || req.headers['authorization'] || "";
        const tokenMatch = authHeader.match(/Token="([^"]+)"/i);
        if (tokenMatch) token = tokenMatch[1];
        else token = urlObj.searchParams.get('api_key') || urlObj.searchParams.get('Token');

        if (uid && token) {
            let cleanUid = uid.replace(/-/g, '').toLowerCase();
            if (cleanUid.startsWith('ffffffff')) cleanUid = cleanUid.replace(/^f+/i, '').replace(/^0+/, '');
            if (cleanUid === "") cleanUid = "0";
            setToken(token, cleanUid);
        }
    } catch(e) {}
    next();
});


// --- 5. Path translation (pure functions, covered by test.js) ---
const deflateUUID = (match) => {
    const deflated = match.replace(/-/g, '').toLowerCase();
    if (deflated.startsWith('ffffffff')) {
        const stripped = deflated.replace(/^f+/i, '').replace(/^0+/, '');
        return stripped === "" ? "0" : stripped;
    }
    return deflated;
};
const UUID_GLOBAL = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/ig;

// Query values that are real UUIDs but not Emby item ids; leave them untouched.
const KEEP_QUERY_KEYS = new Set(['deviceid', 'playsessionid', 'livestreamid', 'api_key', 'apikey', 'token', 'accesstoken']);

const deflatePath = (path) => {
    const [base, query] = path.split(/\?(.*)/s);
    const newBase = base.replace(UUID_GLOBAL, deflateUUID);
    if (query === undefined) return newBase;
    const newQuery = query.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const key = pair.slice(0, eq);
        if (KEEP_QUERY_KEYS.has(key.toLowerCase())) return pair;
        return key + '=' + pair.slice(eq + 1).replace(UUID_GLOBAL, deflateUUID);
    }).join('&');
    return `${newBase}?${newQuery}`;
};

// --- Resume / Next Up split ---
const STRIP_FOR_RESUME = ['limit', 'startindex', 'seriesid', 'nextupdatecutoff', 'enabletotalrecordcount',
    'disablefirstepisode', 'enableresumable', 'enablerewatching', 'userid'];

const deleteParamsCI = (qp, names) => {
    for (const key of [...qp.keys()]) if (names.includes(key.toLowerCase())) qp.delete(key);
};
const getParamCI = (qp, name) => {
    for (const [k, v] of qp) if (k.toLowerCase() === name) return v;
    return null;
};

// What the client asked for, read from the original request URL.
const planSplit = (rawPath) => {
    const isNextUp = /^\/Shows\/NextUp/i.test(rawPath);
    const isResume = /^\/UserItems\/Resume/i.test(rawPath);
    if (!isNextUp && !isResume) return null;
    const qp = new URLSearchParams(rawPath.split('?')[1] || '');
    const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
    const series = getParamCI(qp, 'seriesid');
    return {
        kind: isNextUp ? 'nextup' : 'resume',
        limit: num(getParamCI(qp, 'limit'), null),
        startIndex: num(getParamCI(qp, 'startindex'), 0),
        seriesId: series ? deflateUUID(series) : null,
    };
};

// Ask Emby for a big merged batch; the response is split and trimmed afterwards.
const resumeQuery = (path, { episodesOnly = false }) => {
    const [base, query = ''] = path.split(/\?(.*)/s);
    const qp = new URLSearchParams(query);
    deleteParamsCI(qp, STRIP_FOR_RESUME);
    if (!getParamCI(qp, 'mediatypes')) qp.set('MediaTypes', 'Video');
    if (episodesOnly) {
        deleteParamsCI(qp, ['includeitemtypes']);
        qp.set('IncludeItemTypes', 'Episode');
    }
    qp.set('Limit', String(settings.resumeFetchLimit));
    return `${base}?${qp.toString().replace(/%2C/gi, ',')}`;
};

const ticks = (item) => Number(item?.UserData?.PlaybackPositionTicks) || 0;

// Resume = started items; NextUp = unstarted, unplayed episodes, one per series (Jellyfin semantics).
const splitItems = (data, plan) => {
    if (!data || !Array.isArray(data.Items)) return data;
    let items;
    if (plan.kind === 'resume') {
        items = data.Items.filter((i) => ticks(i) > 0);
    } else {
        const seen = new Set();
        items = data.Items.filter((i) => {
            if (i.Type !== 'Episode' || ticks(i) > 0 || i.UserData?.Played) return false;
            if (plan.seriesId && String(i.SeriesId) !== plan.seriesId) return false;
            if (seen.has(i.SeriesId)) return false;
            seen.add(i.SeriesId);
            return true;
        });
    }
    const total = items.length;
    const end = plan.limit === null ? undefined : plan.startIndex + plan.limit;
    return { ...data, Items: items.slice(plan.startIndex, end), TotalRecordCount: total, StartIndex: plan.startIndex };
};

// Map Jellyfin routes (including the 10.9+ ones) onto their Emby equivalents.
const rewriteRoute = (newPath, userId) => {
    const ID = '([0-9a-fA-F-]{1,36})';
    let m;
    if (/^\/Users\/Me(\?|\/|$)/i.test(newPath)) return newPath.replace(/^\/Users\/Me/i, `/Users/${userId}`);
    if (/^\/UserViews/i.test(newPath)) return newPath.replace(/^\/UserViews/i, `/Users/${userId}/Views`);
    if (/^\/UserItems\/Resume/i.test(newPath)) {
        return resumeQuery(newPath.replace(/^\/UserItems\/Resume/i, `/Users/${userId}/Items/Resume`), {});
    }
    if ((m = newPath.match(new RegExp(`^/UserItems/${ID}/UserData`, 'i')))) return newPath.replace(/^\/UserItems\//i, `/Users/${userId}/Items/`);
    if (/^\/UserPlayedItems\//i.test(newPath)) return newPath.replace(/^\/UserPlayedItems\//i, `/Users/${userId}/PlayedItems/`);
    if (/^\/UserFavoriteItems\//i.test(newPath)) return newPath.replace(/^\/UserFavoriteItems\//i, `/Users/${userId}/FavoriteItems/`);
    if (/^\/Items\/Latest/i.test(newPath)) return newPath.replace(/^\/Items\/Latest/i, `/Users/${userId}/Items/Latest`);
    if (/^\/Shows\/NextUp/i.test(newPath)) {
        // Emby's own NextUp is empty (it lives inside Resume), so build it from Resume.
        return resumeQuery(newPath.replace(/^\/Shows\/NextUp/i, `/Users/${userId}/Items/Resume`), { episodesOnly: true });
    }
    if ((m = newPath.match(/^\/Collections\/([0-9a-fA-F-]+)\/Items/i))) {
        const query = newPath.split('?')[1] || '';
        return `/Users/${userId}/Items?ParentId=${m[1]}&Recursive=true&Fields=BasicSyncInfo,CanDelete${query ? '&' + query : ''}`;
    }
    // Emby leaves UserData out of these lists unless UserId is given; Jellyfin clients leave it off.
    if (new RegExp(`^/Items/${ID}/PlaybackInfo|^/Shows/${ID}/(Episodes|Seasons)`, 'i').test(newPath)) {
        const [base, query = ''] = newPath.split(/\?(.*)/s);
        return base + '?' + (/userid=/i.test(query) ? query : (query ? query + '&' : '') + `UserId=${userId}`);
    }
    // Only per-user item routes move under /Users/<id>; other /Items/<id>/... routes are global in Emby.
    if (new RegExp(`^/Items/${ID}/(Intros|SpecialFeatures|LocalTrailers)`, 'i').test(newPath)
        || new RegExp(`^/Items/${ID}(\\?|$)`, 'i').test(newPath)) {
        return newPath.replace(new RegExp(`^/Items/${ID}`, 'i'), (_, id) => `/Users/${userId}/Items/${id}`);
    }
    if (/^\/Items(\?|$)/i.test(newPath)) return newPath.replace(/^\/Items/i, `/Users/${userId}/Items`);
    return newPath;
};

const JELLY_ONLY_PARAMS = ['streamoptions'];
// Item types Jellyfin has and Emby does not. A request for only these has no Emby equivalent: it must return nothing,
// not everything (which is what dropping the type from the query would do).
const JELLY_ONLY_TYPES = ['basepluginfolder', 'manualplaylistsfolder', 'playlistsfolder', 'livetvchannel', 'livetvprogram'];
const asksOnlyForJellyTypes = (rawUrl) => {
    const [base, query = ''] = rawUrl.split(/\?(.*)/s);
    if (!/^\/(Users\/[^/]+\/)?Items\/?$/i.test(base)) return false;
    const qp = new URLSearchParams(query);
    const values = [];
    for (const [k, v] of qp) if (k.toLowerCase() === 'includeitemtypes') values.push(...v.split(',').filter(Boolean));
    return values.length > 0 && values.every((v) => JELLY_ONLY_TYPES.includes(v.toLowerCase()));
};

// Strip Jellyfin-only query values that make Emby's model binder return 500.
const cleanQuery = (newPath) => {
    if (!newPath.includes('?')) {
        return /^\/(emby\/)?Years\/?$/i.test(newPath) ? `${newPath}?Recursive=true` : newPath;
    }
    const parts = newPath.split('?');
    const queryParams = new URLSearchParams(parts[1]);
    let modified = false;

    // Emby 500s on a duplicate userId when it is already in the path.
    if (/\/Users\//i.test(parts[0])) {
        if (queryParams.has('userId')) { queryParams.delete('userId'); modified = true; }
        if (queryParams.has('UserId')) { queryParams.delete('UserId'); modified = true; }
    }

    // Jellyfin-only parameters that make Emby return 500 (e.g. streamOptions on stream requests).
    for (const key of [...queryParams.keys()]) {
        if (JELLY_ONLY_PARAMS.includes(key.toLowerCase())) { queryParams.delete(key); modified = true; }
    }

    // Emby wants comma-separated lists; Jellyfin repeats the key.
    ['fields', 'Fields', 'includeItemTypes', 'IncludeItemTypes', 'excludeItemTypes', 'ExcludeItemTypes', 'Filters', 'filters', 'sortBy', 'SortBy', 'sortOrder', 'SortOrder'].forEach((param) => {
        if (queryParams.has(param)) {
            const values = queryParams.getAll(param);
            if (values.length > 1) {
                queryParams.delete(param);
                queryParams.set(param, values.join(','));
                modified = true;
            }
        }
    });

    const dropValues = (params, unwanted) => params.forEach((param) => {
        if (!queryParams.has(param)) return;
        const all = queryParams.get(param).split(',');
        const kept = all.filter((v) => v !== '' && !unwanted(v.toLowerCase()));
        if (kept.length !== all.length) {
            if (kept.length > 0) queryParams.set(param, kept.join(','));
            else queryParams.delete(param);
            modified = true;
        }
    });
    dropValues(['fields', 'Fields'], (v) => v === 'basicsyncinfo' || v === 'seasonuserdata');
    // Sort keys Emby rejects with a 500: Default and VideoBitRate have no Emby equivalent;
    // AiredEpisodeOrder is season number then episode number.
    for (const param of ['sortBy', 'SortBy']) {
        if (!queryParams.has(param)) continue;
        const original = queryParams.get(param).split(',').filter((v) => v !== '');
        const mapped = [];
        for (const v of original) {
            const lower = v.toLowerCase();
            if (lower === 'default' || lower === 'videobitrate') continue;
            if (lower === 'airedepisodeorder') mapped.push('ParentIndexNumber', 'IndexNumber');
            else mapped.push(v);
        }
        if (mapped.join(',') !== original.join(',')) {
            if (mapped.length > 0) queryParams.set(param, mapped.join(','));
            else queryParams.delete(param);
            modified = true;
        }
    }
    const jellyExclusives = JELLY_ONLY_TYPES;
    dropValues(['includeItemTypes', 'IncludeItemTypes', 'excludeItemTypes', 'ExcludeItemTypes'], (v) => jellyExclusives.includes(v));

    // Emby only accepts DatePlayed as yyyyMMddHHmmss (UTC); Jellyfin sends ISO 8601.
    for (const key of [...queryParams.keys()]) {
        if (key.toLowerCase() !== 'dateplayed') continue;
        const d = new Date(queryParams.get(key));
        if (!Number.isNaN(d.getTime())) {
            const p = (n, w = 2) => String(n).padStart(w, '0');
            queryParams.set(key, `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`);
            modified = true;
        }
    }

    // Emby ignores fillWidth/fillHeight and sends the original image; maxWidth/maxHeight make it resize server-side.
    if (/\/Images\//i.test(parts[0])) {
        for (const [from, to] of [['fillwidth', 'maxWidth'], ['fillheight', 'maxHeight']]) {
            for (const key of [...queryParams.keys()]) {
                if (key.toLowerCase() !== from) continue;
                if (![...queryParams.keys()].some((k) => k.toLowerCase() === to.toLowerCase())) queryParams.set(to, queryParams.get(key));
                queryParams.delete(key);
                modified = true;
            }
        }
    }

    // Emby's /Years fails with a 500 unless the query is recursive.
    if (/^\/(emby\/)?Years\/?$/i.test(parts[0]) && !queryParams.has('recursive') && !queryParams.has('Recursive')) {
        queryParams.set('Recursive', 'true');
        modified = true;
    }

    if (!modified) return newPath;
    const newQuery = queryParams.toString().replace(/%2C/gi, ',');
    return parts[0] + (newQuery ? '?' + newQuery : '');
};

const transformPath = (rawPath, userId) => {
    let newPath = rawPath;

    // Legacy /UserImage?userId= requests -> Emby's /Users/<id>/Images/Primary
    if (newPath.includes('/UserImage?')) {
        const urlObj = new URL(newPath, 'http://localhost');
        let uid = urlObj.searchParams.get('userId');
        if (uid) {
            uid = deflateUUID(uid);
            urlObj.searchParams.delete('userId');
            const rest = urlObj.searchParams.toString();
            newPath = `/emby/Users/${uid}/Images/Primary` + (rest ? '?' + rest : '');
        }
    }

    if (userId) newPath = rewriteRoute(newPath, userId);
    newPath = cleanQuery(newPath);
    newPath = deflatePath(newPath);

    if (/^\/(Users|Items)\//i.test(newPath) && !newPath.startsWith('/emby/')) newPath = '/emby' + newPath;
    if (/\/Images\//i.test(newPath) && /([?&])token=/i.test(newPath)) newPath = newPath.replace(/([?&])token=/ig, '$1api_key=');
    return newPath;
};

// Large or binary responses (media, HLS segments, images, subtitles) must not be buffered.
const isBinaryPath = (url) => {
    const p = url.split('?')[0];
    return /\/Images\//i.test(p) || /^\/UserImage$/i.test(p) || /\/Download$/i.test(p)
        || /\/(Subtitles|Attachments)\//i.test(p) || /^\/(emby\/)?Audio\//i.test(p)
        || /^\/(emby\/)?Videos\/[^/]+\/(stream|master\.m3u8|main\.m3u8|live\.m3u8|hls1?\/|[^/]*\.(ts|mp4|m4s|aac|mp3|mkv|webm))/i.test(p);
};

const shouldRedirect = (mode, clientProto, embyUrl) => {
    if (mode === 'redirect') return true;
    if (mode !== 'auto') return false;
    return String(clientProto).replace(/:$/, '').toLowerCase() === new URL(embyUrl).protocol.replace(/:$/, '');
};

// Stream requests: let the client fetch straight from Emby when that is safe, otherwise pipe them through.
app.get(/^\/(Videos|Audio)\/[^/]+\/stream/i, (req, res, next) => {
    const clientProto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
    if (!shouldRedirect(settings.streamMode, clientProto, settings.embyUrl)) return next();
    let target = transformPath(req.originalUrl, null);
    const sessionToken = resolveStreamToken(req.originalUrl, req.headers);
    if (sessionToken) target += (target.includes('?') ? '&' : '?') + `api_key=${encodeURIComponent(sessionToken)}`;
    res.redirect(302, `${settings.embyUrl}${target}`);
});

// --- 6. The proxies ---
const getUserIdFromReq = (url, req) => {
    try {
        const urlObj = new URL(url, 'http://localhost');
        const uid = urlObj.searchParams.get('userId') || urlObj.searchParams.get('UserId');
        if (uid) return deflateUUID(uid);
        let token = "";
        const authHeader = req.headers['x-emby-authorization'] || req.headers['authorization'] || "";
        const tokenMatch = authHeader.match(/Token="([^"]+)"/i);
        if (tokenMatch) token = tokenMatch[1];
        else token = urlObj.searchParams.get('api_key') || urlObj.searchParams.get('Token')
            || req.headers['x-emby-token'] || req.headers['x-mediabrowser-token'];
        return tokenToUserId.get(token);
    } catch (e) { return null; }
};

const translateHeaders = (proxyReq, req) => {
    const cleanHeader = (header) => {
        if (!header) return header;
        return header.replace(/Client="[^"]+"/gi, 'Client="Emby"')
                     .replace(/Device="([^"]+)"/gi, (m, deviceName) => `Device="${deviceName.replace(/\+/g, ' ')}"`);
    };
    const jellyAuth = req.headers['x-emby-authorization'];
    if (jellyAuth) proxyReq.setHeader('X-Emby-Authorization', cleanHeader(jellyAuth));
    const stdAuth = req.headers['authorization'];
    if (stdAuth) proxyReq.setHeader('Authorization', cleanHeader(stdAuth));
    const token = req.headers['x-emby-token'] || req.headers['x-mediabrowser-token'];
    if (token) proxyReq.setHeader('X-Emby-Token', token);
};

const deflateBodyUUIDs = (obj) => {
    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            if (UUID_RE.test(obj[key]) && !KEEP_QUERY_KEYS.has(key.toLowerCase())) obj[key] = deflateUUID(obj[key]);
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            deflateBodyUUIDs(obj[key]);
        }
    }
};

const onProxyReq = (proxyReq, req) => {
    try {
        proxyReqUnsafe(proxyReq, req);
    } catch (err) {
        console.error('[Proxy Request Error]', err.message);
        noteError(`[Proxy Request Error] ${err.message}`);
    }
};
const proxyReqUnsafe = (proxyReq, req) => {
    const userId = getUserIdFromReq(req.url, req);
    req.wholbyPlan = userId ? planSplit(req.url) : null;
    const newPath = transformPath(req.url, userId);
    if (settings.debug) console.log(`[Emby Bound]     -> ${req.method} ${redact(newPath)}`);
    // Jellyfin's GET /UserItems/<id>/UserData does not exist on Emby; read the item and return its UserData.
    let finalPath = newPath;
    if (settings.directPlayOnly && req.method === 'POST' && /\/Items\/[^/]+\/PlaybackInfo/i.test(req.url) && req.body && typeof req.body === 'object') {
        forceDirectPlayRequest(req.body);
        const qp = new URLSearchParams(finalPath.split('?')[1] || '');
        for (const [k] of [...qp]) if (/^(enabletranscoding|enabledirectplay|enabledirectstream|maxstreamingbitrate)$/i.test(k)) qp.delete(k);
        finalPath = finalPath.split('?')[0] + (qp.toString() ? '?' + qp.toString() : '');
    }
    if (req.method === 'GET' && /^\/emby\/Users\/[^/]+\/Items\/[^/?]+\/UserData(\?|$)/i.test(finalPath)) {
        finalPath = finalPath.replace(/\/UserData/i, '');
        req.wholbyUnwrap = 'UserData';
    }
    // Jellyfin creates playlists from a JSON body; Emby wants query parameters.
    if (req.method === 'POST' && /^\/Playlists\/?(\?|$)/i.test(req.url) && req.body && typeof req.body === 'object') {
        const body = req.body;
        const qp = new URLSearchParams();
        if (body.Name) qp.set('Name', body.Name);
        if (Array.isArray(body.Ids) && body.Ids.length) qp.set('Ids', body.Ids.map((i) => deflateUUID(String(i))).join(','));
        if (body.UserId) qp.set('UserId', deflateUUID(String(body.UserId)));
        if (body.MediaType) qp.set('MediaType', body.MediaType);
        finalPath = `/emby/Playlists?${qp.toString().replace(/%2C/gi, ',')}`;
    }
    proxyReq.path = finalPath;
    translateHeaders(proxyReq, req);
    const sessionToken = resolveStreamToken(req.url, req.headers);
    if (sessionToken) proxyReq.setHeader('X-Emby-Token', sessionToken);

    if (req.body && Object.keys(req.body).length > 0 && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        deflateBodyUUIDs(req.body);
        fixRequestBody(proxyReq, req);
    }
};

const onError = (err, req, res) => {
    console.error('[Proxy Error]', err.message);
    noteError(`[Proxy Error] ${err.message} (${req.method} ${req.url})`);
    if (!res.headersSent) res.status(502).send('Proxy upstream error');
};

// Binary traffic: streamed straight through, no buffering.
const streamProxy = createProxyMiddleware({ target: settings.embyUrl, router: () => settings.embyUrl, changeOrigin: true, onError, onProxyReq });

// Everything else: buffered so the JSON can be translated.
const jsonProxy = createProxyMiddleware({
    target: settings.embyUrl,
    router: () => settings.embyUrl, // read on every request so the dashboard can change the Emby server
    changeOrigin: true,
    selfHandleResponse: true,
    onError,
    // The body is parsed and rewritten here, so ask Emby for it uncompressed.
    // (Clients that send Accept-Encoding made responseInterceptor fail with "incorrect header check".)
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Accept-Encoding', 'identity'); // must precede onProxyReq, which may flush headers
        onProxyReq(proxyReq, req, res);
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const isJson = proxyRes.headers['content-type']?.includes('application/json');

        if (proxyRes.statusCode >= 400) {
            console.error(`[Emby Error] ${proxyRes.statusCode} ${req.method} ${redact(req.url)}`);
            stats.embyErrors += 1;
            noteError(`[Emby Error] ${proxyRes.statusCode} ${req.method} ${req.url}`);
            // Emby answers some Jellyfin-only list queries with a 5xx; show an empty list instead of failing the screen.
            // Auth and client errors (4xx) are passed through so logins and lookups fail honestly.
            if (isJson && proxyRes.statusCode >= 500 && req.method === 'GET') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return Buffer.from(JSON.stringify({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
            }
            return responseBuffer;
        }

        if (proxyRes.headers['content-type']?.includes('application/json')) {
            try {
                // Some Emby files (manifests, localization strings) start with a UTF-8 BOM, which JSON.parse rejects.
                let data = JSON.parse(responseBuffer.toString('utf8').replace(/^﻿/, ''));

                if (req.url.match(/\/System\/Info\/Public/i)) {
                    data.Id = PROXY_SERVER_ID;
                    data.Version = settings.reportedVersion;
                    data.ProductName = "Jellyfin Server";
                    data.StartupWizardCompleted = true;
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (req.url.match(/\/System\/Info/i)) {
                    data.Id = PROXY_SERVER_ID;
                    data.ServerName = "Wholby Proxy";
                    data.Version = settings.reportedVersion;
                    return Buffer.from(JSON.stringify(data));
                }

                if (req.url.match(/\/Users\/AuthenticateByName/i)) {
                    if (data.AccessToken && data.User) {
                        let uidStr = String(data.User.Id).replace(/-/g, '').toLowerCase();
                        setToken(data.AccessToken, uidStr);
                    }
                    if (data.User) data.User = patchUser(data.User);
                    if (data.SessionInfo) data.SessionInfo = patchSessionInfo(data.SessionInfo);
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (settings.directPlayOnly && /\/PlaybackInfo/i.test(req.url)) forceDirectPlayResponse(data);

                if (data.PlaySessionId && /\/PlaybackInfo/i.test(req.url)) {
                    rememberPlaySession(data.PlaySessionId, tokenFromRequest(req.url, req.headers));
                }

                // Emby's name-only lists (Years, OfficialRatings, ...) lack the Id and Type that Jellyfin clients require.
                const named = req.url.match(/^\/?(?:emby\/)?(Years|Genres|Studios|MusicGenres|Persons|OfficialRatings)(?:[/?]|$)/i);
                if (named && data && Array.isArray(data.Items)) {
                    const type = { years: 'Year', genres: 'Genre', studios: 'Studio', musicgenres: 'MusicGenre', persons: 'Person', officialratings: 'Folder' }[named[1].toLowerCase()];
                    for (const item of data.Items) {
                        if (item && item.Name !== undefined) {
                            if (item.Id === undefined) item.Id = createHash('md5').update(`${type}:${item.Name}`).digest('hex');
                            if (!item.Type) item.Type = type;
                        }
                    }
                }

                if (Array.isArray(data) && /\/Search\/Hints/i.test(req.url)) {
                    data = { SearchHints: data, TotalRecordCount: data.length };
                }

                const userDataRoute = req.method !== 'GET' ? req.url.match(USER_DATA_ROUTE) : null;
                if (userDataRoute && /^(?:\/emby)?\/(?:UserFavoriteItems|UserPlayedItems)\//i.test(req.url.split('?')[0])) {
                    return Buffer.from(JSON.stringify(normalizeUserData(data, deflateUUID(decodeURIComponent(userDataRoute[1])))));
                }

                if (req.wholbyUnwrap) {
                    const wrapped = { Id: data.Id, UserData: data[req.wholbyUnwrap] };
                    deepPatch(wrapped);
                    return Buffer.from(JSON.stringify(wrapped.UserData ?? {}));
                }

                if (req.wholbyPlan) data = splitItems(data, req.wholbyPlan);

                if (req.url.match(/^\/?(emby\/)?Users(\/Public|\?|$)/i) && Array.isArray(data)) {
                    data = data.map(u => patchUser(u));
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (req.url.match(/^\/?(emby\/)?Users\/(Me|[a-z0-9\-]+)(\?|$)/i) && data.Id) {
                    data = patchUser(data);
                    return Buffer.from(JSON.stringify(data)); 
                }

                deepPatch(data); 
                return Buffer.from(JSON.stringify(data));
            } catch (e) {
                console.error("[Proxy Intercept Error]", e);
                noteError(`[Proxy Intercept Error] ${e && e.message} (${req.method} ${req.url})`);
                return responseBuffer; 
            }
        }
        return responseBuffer;
    })
});

// Jellyfin's /socket is Emby's /embywebsocket (same JSON message envelope).
const wsProxy = createProxyMiddleware({
    target: settings.embyUrl,
    router: () => settings.embyUrl,
    changeOrigin: true,
    ws: true,
    pathRewrite: { '^/socket': '/embywebsocket' },
    onError,
});
app.use('/socket', wsProxy);

app.use('/', (req, res, next) => (isBinaryPath(req.url) ? streamProxy : jsonProxy)(req, res, next));

if (require.main === module) {
    loadTokens();
    loadPrefs();
    loadSettings();
    if (!parseEmbyUrl(settings.embyUrl).ok) {
        console.error('EMBY_URL is missing or invalid. Set it to the full Emby URL, e.g. http://192.168.1.100:8096');
        process.exit(1);
    }
    if (!UUID_RE.test(PROXY_SERVER_ID)) {
        console.error('PROXY_SERVER_ID must be a UUID (generate one with `uuidgen`).');
        process.exit(1);
    }
    const server = app.listen(PORT, HOST, () => console.log(`Wholby Proxy listening on ${HOST}:${PORT} -> ${settings.embyUrl} (streams: ${settings.streamMode})`));
    const adminPort = parseInt(process.env.ADMIN_PORT, 10) || 0;
    if (adminPort) {
        require('./admin').start({
            port: adminPort,
            host: process.env.ADMIN_HOST || '127.0.0.1',
            dataDir: path.dirname(TOKEN_FILE),
            settings, validateSettings, applySettings, stats, recentErrors,
            clearErrors: () => { recentErrors.length = 0; },
            serverId: PROXY_SERVER_ID,
            listen: { host: HOST, port: PORT },
            counts: () => ({ logins: tokenToUserId.size, playSessions: playSessionToken.size, devices: deviceToken.size }),
            version: require('./package.json').version,
        });
    }
    server.on('upgrade', (req, socket, head) => {
        if (/^\/socket(\?|$)/i.test(req.url)) wsProxy.upgrade(req, socket, head);
        else socket.destroy();
    });
}

module.exports = { parseEmbyUrl, settings, validateSettings, applySettings, stats, recentErrors, rewriteUniversalAudio, rememberDevice, forceDirectPlayRequest, forceDirectPlayResponse, isTranscodeRequest, normalizeUserData, asksOnlyForJellyTypes, app, rememberPlaySession, resolveStreamToken, shouldRedirect, planSplit, splitItems, resumeQuery, toUUID, deflateUUID, deflatePath, cleanQuery, rewriteRoute, transformPath, isBinaryPath, redact };
