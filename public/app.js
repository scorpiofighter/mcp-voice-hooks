// ═══════════════════════════════════════════════════════════════════
// Voice Mode for Claude Code — front end
//
// The interface is state-first. Four things can independently be wrong,
// and the old UI showed none of them, so a broken setup looked identical
// to a working one:
//
//   link   — can we reach the server at all         (SSE + WebSocket)
//   input  — is the microphone genuinely open       (track state + level)
//   output — will anything actually be spoken back  (AudioContext + server)
//   target — which Claude session hears my voice    (selected vs server)
//
// Every one of those is derived from a real signal, rendered permanently,
// and every failure names its own fix.
// ═══════════════════════════════════════════════════════════════════

// ── Environment probe ──────────────────────────────────────────────
const Env = (() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const iosBrowser = /CriOS/.test(ua) ? 'Chrome'
        : /FxiOS/.test(ua) ? 'Firefox'
            : /EdgiOS/.test(ua) ? 'Edge'
                : /OPiOS|OPT\//.test(ua) ? 'Opera'
                    : null;
    return {
        isIOS,
        // On iOS every browser is WebKit underneath, but only Safari exposes
        // the Web Speech API. Chrome/Firefox/Edge there cannot transcribe.
        iosNonSafari: isIOS && iosBrowser !== null,
        iosBrowserName: iosBrowser,
        browserSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        secureContext: window.isSecureContext,
        canCapture: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    };
})();

// Sustained mic energy while Claude is talking means the speaker is
// bleeding back into the microphone.
const ECHO_RMS_THRESHOLD = 0.035;
const ECHO_SUSTAIN_MS = 600;
// Above this the user is audibly speaking right now, not just idling.
const HEARING_LEVEL = 0.07;

// ═══════════════════════════════════════════════════════════════════
// AudioPlayer — plays PCM16 chunks from the WebSocket TTS stream.
//
// Unchanged in behaviour, with one addition: the context is created up
// front in its suspended state so the page can *report* that sound is
// locked before anything tries to play. Resuming still only ever happens
// from a user gesture — the iOS requirement is untouched.
// ═══════════════════════════════════════════════════════════════════
class AudioPlayer {
    constructor(onStateChange) {
        this.playbackContext = null;
        this.nextStartTime = 0;
        this.scheduledSources = [];
        this.gainNode = null;
        this.ttsActive = false;
        this.currentAudioId = null;
        this.isFirstChunk = true;
        this.onStateChange = onStateChange || (() => { });
    }

    // Safe to call at any time — a context created without a gesture simply
    // starts suspended, which is exactly the state we want to surface.
    ensureContext() {
        if (this.playbackContext) return this.playbackContext;
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            this.playbackContext = new Ctor({ sampleRate: 22050 });
            this.gainNode = this.playbackContext.createGain();
            this.gainNode.connect(this.playbackContext.destination);
            this.playbackContext.onstatechange = () => this.onStateChange(this.playbackContext.state);
        } catch (e) {
            console.error('[Audio] Could not create playback context:', e);
            return null;
        }
        return this.playbackContext;
    }

    get locked() {
        return !this.playbackContext || this.playbackContext.state !== 'running';
    }

    // Must be called on a user gesture (iOS Safari requirement)
    async unlock() {
        this.ensureContext();
        if (!this.playbackContext) return false;
        await this.playbackContext.resume();
        // Play a silent buffer to warm up the iOS audio pipeline
        const silence = this.playbackContext.createBuffer(1, 1, 22050);
        const source = this.playbackContext.createBufferSource();
        source.buffer = silence;
        source.connect(this.playbackContext.destination);
        source.start();
        this.onStateChange(this.playbackContext.state);
        return !this.locked;
    }

    // A short two-note confirmation so "sound is on now" is unmistakable
    chime() {
        if (this.locked) return;
        const ctx = this.playbackContext;
        const now = ctx.currentTime;
        [660, 880].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.11;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.2);
        });
    }

    prepareForPlayback(sampleRate, audioId) {
        this.ttsActive = true;
        this.currentAudioId = audioId;
        this.isFirstChunk = true;
        // Only reset scheduling if no audio is queued — otherwise new audio
        // should play after the currently scheduled audio finishes
        if (this.playbackContext && this.nextStartTime < this.playbackContext.currentTime) {
            this.nextStartTime = this.playbackContext.currentTime;
        }
    }

    // Convert Int16 PCM buffer to Float32
    static int16ToFloat32(int16Array) {
        const float32 = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32[i] = int16Array[i] / 32768;
        }
        return float32;
    }

    // Schedule a PCM16 chunk for gapless playback
    playPCMChunk(pcm16Buffer, sampleRate = 22050) {
        if (!this.playbackContext || this.playbackContext.state !== 'running') return;

        const int16 = new Int16Array(pcm16Buffer);
        const float32 = AudioPlayer.int16ToFloat32(int16);
        const audioBuffer = this.playbackContext.createBuffer(1, float32.length, sampleRate);
        audioBuffer.copyToChannel(float32, 0);

        const source = this.playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode || this.playbackContext.destination);

        const now = this.playbackContext.currentTime;
        const startTime = Math.max(now, this.nextStartTime);
        source.start(startTime);
        this.nextStartTime = startTime + audioBuffer.duration;
        this.scheduledSources.push(source);

        // Clean up finished sources
        source.onended = () => {
            const idx = this.scheduledSources.indexOf(source);
            if (idx !== -1) this.scheduledSources.splice(idx, 1);
        };
    }

    finishPlayback() {
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    clear() {
        // Stop all scheduled sources
        for (const source of this.scheduledSources) {
            try { source.stop(); } catch (_e) { /* may already be stopped */ }
        }
        this.scheduledSources = [];
        this.nextStartTime = 0;
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    isPlaying() {
        return this.ttsActive || this.scheduledSources.length > 0;
    }
}

// ═══════════════════════════════════════════════════════════════════
// MessengerClient
// ═══════════════════════════════════════════════════════════════════
class MessengerClient {
    constructor() {
        this.baseUrl = window.location.origin;

        // Conversation elements
        this.conversationMessages = document.getElementById('conversationMessages');
        this.conversationContainer = document.getElementById('conversationContainer');
        this.waitingIndicator = document.getElementById('waitingIndicator');

        // Composer
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');

        // Microphone
        this.micBtn = document.getElementById('micBtn');
        this.micDock = document.getElementById('micDock');
        this.micLabel = document.getElementById('micLabel');

        // Status strip
        this.statusLink = document.getElementById('statusLink');
        this.statusMic = document.getElementById('statusMic');
        this.statusSound = document.getElementById('statusSound');
        this.targetPill = document.getElementById('targetPill');
        this.targetName = document.getElementById('targetName');
        this.alertStack = document.getElementById('alertStack');

        // Recognition mode
        this.recognitionModeSelect = document.getElementById('recognitionModeSelect');
        this.recognitionModeHint = document.getElementById('recognitionModeHint');

        // Settings
        this.settingsToggleHeader = document.getElementById('settingsToggleHeader');
        this.settingsContent = document.getElementById('settingsContent');
        this.settingsCloseBtn = document.getElementById('settingsCloseBtn');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.feedbackSoundModeSelect = document.getElementById('feedbackSoundMode');
        this.testTTSBtn = document.getElementById('testTTSBtn');
        this.rerunChecksBtn = document.getElementById('rerunChecksBtn');
        this.showTipsBtn = document.getElementById('showTipsBtn');

        // Sessions
        this.sessionSidebar = document.getElementById('sessionSidebar');
        this.sessionList = document.getElementById('sessionList');
        this.sidebarOpenBtn = document.getElementById('sidebarOpenBtn');
        this.sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
        this.backgroundEnforcementToggle = document.getElementById('backgroundEnforcementToggle');
        this.scrim = document.getElementById('scrim');

        // Tappable questions
        this.questionCard = document.getElementById('questionCard');
        this.question = null;      // the question document currently on screen
        this.answers = {};         // question index -> array of chosen labels
        this._questionEtag = null;

        // ── State ──────────────────────────────────────────────────
        this.recognitionMode = 'server'; // 'server' or 'browser'
        this.serverRecognitionAvailable = false;
        this.isListening = false;
        this.isInterimText = false;
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';

        // Derived state channels, all rendered permanently
        this.starting = false;
        this.suspended = false;
        this.blockedReason = null;
        this.serverVoiceActive = false;
        this.lastFetchOk = null;
        this.level = 0;

        // TTS state
        this.speechRate = 1.0;

        // WebSocket audio capture state
        this.audioWs = null;
        this.audioContext = null;
        this.audioWorkletNode = null;
        this.mediaStream = null;
        this.wsReconnectTimer = null;
        this.wsReconnectDelay = 1000;

        // WebSocket TTS audio player
        this.audioPlayer = new AudioPlayer(() => this.render());
        this.audioPlayer.ensureContext();
        this.wsConnected = false;

        // Voice state (driven by server SSE events)
        this.currentVoiceState = 'inactive';

        // Session state
        this.sessions = [];
        this.activeSessionKey = null;       // Server's selected key
        this.selectedSessionKey = null;     // User's UI selection
        this.unreadCounts = {};

        // Alerts
        this.alerts = new Map();
        this.dismissed = new Set();
        this._alertSignature = '';

        // Echo detection
        this._micMuted = false;
        this._echoStart = 0;
        this._echoReported = false;

        // Initialize
        this.initializeSpeechRecognition();
        this.initializeTTSEvents();
        this.initializeSessionSidebar();
        this.setupEventListeners();
        this.loadPreferences();
        this.checkServerRecognition();
        this.loadData();
        this.pollQuestion();
        this.runEnvironmentChecks();
        this.maybeShowFirstRunTips();
        this.render();

        // Auto-refresh every 2 seconds
        setInterval(() => this.loadData(), 2000);
        // Refresh sessions every 3 seconds
        setInterval(() => this.loadSessions(), 3000);
        // Keep the status strip honest even when nothing else changes
        setInterval(() => this.render(), 1000);
        // Watch for a question waiting to be answered
        setInterval(() => this.pollQuestion(), 1500);
    }

    debugLog(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Derived state
    // ═══════════════════════════════════════════════════════════════

    /** connecting · live · offline */
    get linkState() {
        const sse = this.eventSource ? this.eventSource.readyState : 2;
        if (this.lastFetchOk === false) return 'offline';
        if (sse === 1) return 'live';
        if (sse === 0) return this.lastFetchOk === true ? 'live' : 'connecting';
        return 'offline';
    }

    /** off · starting · listening · hearing · suspended · blocked */
    get inputState() {
        if (this.blockedReason) return 'blocked';
        if (this.suspended) return 'suspended';
        if (!this.isListening) return 'off';
        if (this.starting) return 'starting';
        return this.level >= HEARING_LEVEL ? 'hearing' : 'listening';
    }

    /** locked · off · ready · speaking */
    get outputState() {
        if (this.audioPlayer.locked) return 'locked';
        if (this.currentVoiceState === 'speaking' || this.audioPlayer.isPlaying()) return 'speaking';
        if (!this.serverVoiceActive) return 'off';
        return 'ready';
    }

    /** The single visual state of the primary control. */
    get micState() {
        if (this.blockedReason) return 'blocked';
        if (this.suspended) return 'suspended';
        if (!this.isListening) return this.audioPlayer.locked ? 'locked' : 'idle';
        if (this.starting) return 'starting';
        if (this.outputState === 'speaking') return 'speaking';
        if (this.currentVoiceState === 'processing') return 'processing';
        return this.level >= HEARING_LEVEL ? 'hearing' : 'listening';
    }

    get targetDrifted() {
        return !!(this.activeSessionKey && this.selectedSessionKey &&
            this.activeSessionKey !== this.selectedSessionKey);
    }

    // ═══════════════════════════════════════════════════════════════
    // Render — state to pixels. Cheap enough to call on every tick.
    // ═══════════════════════════════════════════════════════════════

    render() {
        this.renderChips();
        this.renderMic();
        this.renderTarget();
        this.renderAlerts();
    }

    setChip(el, state, text) {
        if (!el) return;
        if (el.dataset.state !== state) el.dataset.state = state;
        const label = el.querySelector('.chip-text');
        if (label && label.textContent !== text) label.textContent = text;
    }

    renderChips() {
        const link = this.linkState;
        this.setChip(this.statusLink,
            link === 'live' ? 'ok' : link === 'connecting' ? 'busy' : 'bad',
            link === 'live' ? 'Live' : link === 'connecting' ? 'Connecting' : 'Offline');

        const input = this.inputState;
        const micMap = {
            off: ['off', 'Mic off'],
            starting: ['busy', 'Starting'],
            listening: ['ok', 'Mic on'],
            hearing: ['ok', 'Hearing you'],
            suspended: ['warn', 'Mic stopped'],
            blocked: ['bad', 'Mic blocked'],
        };
        this.setChip(this.statusMic, ...micMap[input]);

        const output = this.outputState;
        const soundMap = {
            locked: ['warn', 'Sound locked'],
            off: ['warn', 'Sound off'],
            ready: ['ok', 'Sound on'],
            speaking: ['ok', 'Speaking'],
        };
        this.setChip(this.statusSound, ...soundMap[output]);
    }

    renderMic() {
        const state = this.micState;
        const labels = {
            idle: 'Tap to talk',
            locked: 'Tap to enable sound',
            starting: 'Starting…',
            listening: 'Listening',
            hearing: 'Hearing you',
            processing: 'Claude is thinking',
            speaking: 'Claude is speaking',
            suspended: 'Tap to resume',
            blocked: this.blockedReason ? this.blockedReason.short : 'Not available',
        };

        if (this.micDock.dataset.state !== state) this.micDock.dataset.state = state;
        const text = labels[state];
        if (this.micLabel.textContent !== text) this.micLabel.textContent = text;

        this.micBtn.setAttribute('aria-pressed', this.isListening ? 'true' : 'false');
        this.micBtn.setAttribute('aria-label',
            this.isListening ? 'Stop listening' : 'Start listening');

        // .listening stays on the button — other code and styling depend on it
        this.micBtn.classList.toggle('listening', this.isListening);

        this.micDock.style.setProperty('--level', this.level.toFixed(3));
    }

    renderTarget() {
        const session = this.sessions.find(s => s.key === this.selectedSessionKey);
        const name = session
            ? this.describeSession(session)
            : (this.selectedSessionKey ? 'Session ended' : 'No session yet');
        if (this.targetName.textContent !== name) this.targetName.textContent = name;

        const drift = this.targetDrifted ? 'true' : 'false';
        if (this.targetPill.dataset.drift !== drift) this.targetPill.dataset.drift = drift;
    }

    // ═══════════════════════════════════════════════════════════════
    // Alerts — never a dead control, never a silent failure
    // ═══════════════════════════════════════════════════════════════

    setAlert(id, spec) {
        if (this.dismissed.has(id)) return;
        this.alerts.set(id, Object.assign({ id, tone: 'warn' }, spec));
        this.renderAlerts();
    }

    clearAlert(id) {
        const had = this.alerts.delete(id);
        // Clearing the condition also re-arms the alert for next time
        this.dismissed.delete(id);
        if (had) this.renderAlerts();
    }

    renderAlerts() {
        const list = Array.from(this.alerts.values());
        const signature = list.map(a => `${a.id}:${a.title}:${a.detail || ''}`).join('|');
        if (signature === this._alertSignature) return;
        this._alertSignature = signature;

        this.alertStack.textContent = '';
        for (const alert of list) {
            this.alertStack.appendChild(this.buildAlert(alert));
        }
    }

    buildAlert(alert) {
        const el = document.createElement('div');
        el.className = 'alert';
        el.dataset.tone = alert.tone;
        el.setAttribute('role', alert.tone === 'error' ? 'alert' : 'status');

        const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        glyph.setAttribute('class', 'alert-glyph');
        glyph.setAttribute('viewBox', '0 0 24 24');
        glyph.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', alert.tone === 'info'
            ? 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m1 15h-2v-6h2zm0-8h-2V7h2z'
            : 'M12 2 1 21h22zm1 15h-2v-2h2zm0-4h-2V9h2z');
        glyph.appendChild(path);
        el.appendChild(glyph);

        const body = document.createElement('div');
        body.className = 'alert-body';

        const title = document.createElement('p');
        title.className = 'alert-title';
        title.textContent = alert.title;
        body.appendChild(title);

        if (alert.detail) {
            const detail = document.createElement('p');
            detail.className = 'alert-detail';
            detail.textContent = alert.detail;
            body.appendChild(detail);
        }

        if (alert.actions && alert.actions.length) {
            const actions = document.createElement('div');
            actions.className = 'alert-actions';
            for (const action of alert.actions) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'alert-action' + (action.quiet ? ' alert-action--quiet' : '');
                btn.textContent = action.label;
                btn.addEventListener('click', () => action.run());
                actions.appendChild(btn);
            }
            body.appendChild(actions);
        }
        el.appendChild(body);

        if (alert.dismissible !== false) {
            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'alert-dismiss';
            dismiss.setAttribute('aria-label', 'Dismiss');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('aria-hidden', 'true');
            const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute('d', 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z');
            svg.appendChild(p);
            dismiss.appendChild(svg);
            dismiss.addEventListener('click', () => {
                this.dismissed.add(alert.id);
                this.alerts.delete(alert.id);
                this.renderAlerts();
            });
            el.appendChild(dismiss);
        }

        return el;
    }

    // ═══════════════════════════════════════════════════════════════
    // Environment + health checks
    // ═══════════════════════════════════════════════════════════════

    runEnvironmentChecks() {
        // A page served over plain HTTP from anywhere but localhost cannot
        // open the microphone at all — the failure is otherwise silent.
        if (!Env.secureContext) {
            this.blockedReason = {
                short: 'Needs a secure link',
                title: 'The microphone needs a secure connection',
                detail: `This page is on ${location.protocol}//${location.host}. Browsers only allow microphone access over https, or on localhost. Open the https address for this server instead.`,
            };
        } else if (!Env.canCapture) {
            this.blockedReason = {
                short: 'No microphone access',
                title: 'This browser will not give the page a microphone',
                detail: 'Try Safari on iOS, or Chrome on a computer.',
            };
        } else {
            this.blockedReason = null;
        }
        this.applyBlockedAlert();
        this.checkAudioLock();
        this.render();
    }

    // Recognition availability depends on a server round-trip, so it is
    // re-evaluated once that answer lands.
    checkRecognitionAvailability() {
        // Chrome/Firefox/Edge on iOS have no Web Speech API. That only
        // matters when browser recognition is the only route — when this Mac
        // can transcribe, those browsers work perfectly well.
        const noRoute = !this.serverRecognitionAvailable && !Env.browserSpeech;
        if (noRoute && !this.blockedReason) {
            this.blockedReason = Env.iosNonSafari
                ? {
                    short: 'Open in Safari',
                    title: `Speech recognition isn't available in ${Env.iosBrowserName} on iOS`,
                    detail: 'Only Safari can transcribe speech on an iPhone or iPad. Open this same address in Safari.',
                }
                : {
                    short: 'No speech recognition',
                    title: 'Nothing here can turn your speech into text',
                    detail: 'This browser has no speech recognition, and this Mac is not running the speech recognizer either. Use Safari, or start the server with the recognizer available.',
                };
        } else if (!noRoute && this.blockedReason &&
            (this.blockedReason.short === 'Open in Safari' || this.blockedReason.short === 'No speech recognition')) {
            this.blockedReason = null;
        }
        this.applyBlockedAlert();
        this.render();
    }

    applyBlockedAlert() {
        if (this.blockedReason) {
            this.setAlert('blocked', {
                tone: 'error',
                title: this.blockedReason.title,
                detail: this.blockedReason.detail,
                dismissible: false,
            });
        } else {
            this.clearAlert('blocked');
        }
    }

    // Problem 1 — audio silently locked until a gesture. Say so, up front.
    checkAudioLock() {
        if (this.blockedReason) { this.clearAlert('audio-locked'); return; }
        if (this.audioPlayer.locked) {
            this.setAlert('audio-locked', {
                tone: 'warn',
                title: 'Sound is switched off until you tap',
                detail: 'iPhones and iPads block audio until you touch the page. Nothing Claude says will be heard until you do.',
                dismissible: false,
                actions: [{ label: 'Enable sound', run: () => this.unlockAudioFromGesture() }],
            });
        } else {
            this.clearAlert('audio-locked');
        }
    }

    // Problem 2 — being heard while nothing can speak back.
    checkVoiceOutput() {
        if (this.isListening && !this.serverVoiceActive && !this.audioPlayer.locked) {
            this.setAlert('voice-off', {
                tone: 'warn',
                title: 'Claude can hear you, but will not speak back',
                detail: 'Voice replies are switched off on the server. You will see answers on screen but hear nothing.',
                actions: [{
                    label: 'Turn on replies',
                    run: async () => { await this.updateVoiceActive(true); this.checkVoiceOutput(); this.render(); },
                }],
            });
        } else {
            this.clearAlert('voice-off');
        }
    }

    async unlockAudioFromGesture() {
        const ok = await this.audioPlayer.unlock();
        this.checkAudioLock();
        if (ok) {
            this.audioPlayer.chime();
            this.setAlert('audio-ok', {
                tone: 'info',
                title: 'Sound is on',
                detail: 'You should have just heard two short notes.',
            });
            setTimeout(() => { this.alerts.delete('audio-ok'); this.renderAlerts(); }, 5000);
        }
        this.render();
        return ok;
    }

    // Problem 4 — the assistant's own voice reaching the microphone.
    maybeShowFirstRunTips() {
        if (localStorage.getItem('voiceHooksSeenTips') === 'true') return;
        this.showTips();
    }

    showTips() {
        this.dismissed.delete('tips');
        this.setAlert('tips', {
            tone: 'info',
            title: 'Use headphones if you can',
            detail: 'Without them, Claude\'s own voice gets picked up by the microphone and typed back as if you had said it.',
            actions: [{
                label: 'Got it',
                quiet: true,
                run: () => {
                    localStorage.setItem('voiceHooksSeenTips', 'true');
                    this.dismissed.add('tips');
                    this.alerts.delete('tips');
                    this.renderAlerts();
                },
            }],
        });
    }

    reportEcho() {
        if (this._echoReported) return;
        this._echoReported = true;
        this.setAlert('echo', {
            tone: 'warn',
            title: 'Claude\'s voice is reaching your microphone',
            detail: 'What Claude says is being picked up and sent back as if you had said it. Plug in headphones, or turn the volume down.',
        });
    }

    // Problem 5 — iOS freezes background tabs and everything stops dead.
    verifyAfterResume() {
        this.checkAudioLock();

        if (!this.isListening) {
            this.loadData();
            this.loadSessions();
            this.render();
            return;
        }

        const broken = [];
        if (this.audioPlayer.locked) broken.push('sound');
        if (!this.audioWs || this.audioWs.readyState !== WebSocket.OPEN) broken.push('the connection');
        const track = this.mediaStream && this.mediaStream.getAudioTracks()[0];
        if (!track || track.readyState !== 'live' || track.muted) broken.push('the microphone');
        if (this.eventSource && this.eventSource.readyState === 2) broken.push('live updates');

        if (broken.length) {
            this.suspended = true;
            this.setAlert('suspended', {
                tone: 'error',
                title: 'Voice stopped while this page was in the background',
                detail: `${this.sentenceList(broken)} shut down and did not come back on its own. Nothing you say right now is reaching Claude.`,
                dismissible: false,
                actions: [{ label: 'Resume voice', run: () => this.resumeVoice() }],
            });
        } else {
            this.clearAlert('suspended');
        }
        this.render();
    }

    sentenceList(items) {
        const capped = items.map((s, i) => i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);
        if (capped.length === 1) return capped[0];
        return capped.slice(0, -1).join(', ') + ' and ' + capped[capped.length - 1];
    }

    async resumeVoice() {
        this.clearAlert('suspended');
        this.suspended = false;
        this.render();
        await this.teardownVoice();
        await this.startVoiceDictation();
    }

    // ═══════════════════════════════════════════════════════════════
    // Server events (SSE)
    // ═══════════════════════════════════════════════════════════════

    initializeTTSEvents() {
        this.eventSource = new EventSource(`${this.baseUrl}/api/tts-events`);

        this.eventSource.onopen = () => this.render();

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'connected') {
                    // Connected (or reconnected) — sync voice state.
                    // Covers both first connect and reconnect after a restart.
                    console.log('[SSE] Connected to server, syncing voice state');
                    this.syncVoiceStateToServer();
                } else if (data.type === 'voice-state') {
                    // Server is the single source of truth for voice state
                    this.currentVoiceState = data.state;
                    if (data.sessionKey) this.activeSessionKey = data.sessionKey;
                    this.updateVoiceStateUI(data.state);
                } else if (data.type === 'tts-clear') {
                    this.audioPlayer.clear();
                } else if (data.type === 'waitStatus') {
                    this.handleWaitStatus(data.isWaiting);
                } else if (data.type === 'session-reset') {
                    // New Claude session started — re-sync voice state
                    console.log('[SSE] New Claude session detected, re-syncing voice state');
                    this.syncVoiceStateToServer();
                }
                this.render();
            } catch (error) {
                console.error('Failed to parse TTS event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            // Reset voice state to prevent stale UI while disconnected
            this.currentVoiceState = 'inactive';
            this.updateVoiceStateUI('inactive');
            this.render();
        };
    }

    handleWaitStatus(isWaiting) {
        // Fallback handler for waitStatus SSE events.
        // voice-state SSE events are the primary driver for UI state.
        if (this.waitingIndicator) {
            const wasAtBottom = this.isUserNearBottom();
            this.waitingIndicator.style.display = isWaiting ? 'block' : 'none';
            if (isWaiting && wasAtBottom) {
                this.scrollToBottom();
            }
        }
    }

    updateVoiceStateUI(state) {
        if (!this.waitingIndicator) return;

        const wasAtBottom = this.isUserNearBottom();
        const captions = {
            listening: 'Claude is waiting for you',
            processing: 'Claude is thinking',
            speaking: 'Claude is speaking',
            stopped: 'Claude\'s turn ended',
        };

        if (captions[state]) {
            this.waitingIndicator.textContent = captions[state];
            this.waitingIndicator.style.display = 'block';
        } else {
            this.waitingIndicator.style.display = 'none';
        }

        if (state !== 'inactive' && wasAtBottom) {
            this.scrollToBottom();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Sessions
    // ═══════════════════════════════════════════════════════════════

    initializeSessionSidebar() {
        if (this.sidebarOpenBtn) {
            this.sidebarOpenBtn.addEventListener('click', () => this.toggleSidebar(true));
        }
        if (this.sidebarCloseBtn) {
            this.sidebarCloseBtn.addEventListener('click', () => this.toggleSidebar(false));
        }
        if (this.targetPill) {
            this.targetPill.addEventListener('click', () => this.toggleSidebar(true));
        }
        // Delegated click handler — survives innerHTML replacement
        if (this.sessionList) {
            this.sessionList.addEventListener('click', (e) => {
                const item = e.target.closest('.session-item');
                if (!item) return;
                const key = item.dataset.sessionKey;
                if (!key) return;
                this.switchActiveSession(key);
                this.toggleSidebar(false);
            });
        }
        // Background enforcement toggle
        if (this.backgroundEnforcementToggle) {
            const saved = localStorage.getItem('backgroundVoiceEnforcement');
            if (saved !== null) {
                this.backgroundEnforcementToggle.checked = saved === 'true';
                this.updateBackgroundEnforcement(saved === 'true');
            } else {
                this.loadBackgroundEnforcement();
            }
            this.backgroundEnforcementToggle.addEventListener('change', (e) => {
                this.updateBackgroundEnforcement(e.target.checked);
            });
        }
        this.loadSessions();
    }

    toggleSidebar(open) {
        if (!this.sessionSidebar) return;
        this.sessionSidebar.classList.toggle('collapsed', !open);
        document.body.classList.toggle('sidebar-open', open);
        if (this.sidebarOpenBtn) {
            this.sidebarOpenBtn.classList.toggle('hidden', open);
            this.sidebarOpenBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        this.updateScrim();
        if (open) this.sessionSidebar.focus?.();
    }

    toggleSettings(open) {
        if (!this.settingsContent) return;
        this.settingsContent.classList.toggle('open', open);
        this.settingsToggleHeader.setAttribute('aria-expanded', open ? 'true' : 'false');
        this.updateScrim();
    }

    updateScrim() {
        const anyOpen = this.settingsContent.classList.contains('open') ||
            !this.sessionSidebar.classList.contains('collapsed');
        this.scrim.classList.toggle('visible', anyOpen);
    }

    closeSheets() {
        this.toggleSettings(false);
        this.toggleSidebar(false);
    }

    async loadSessions() {
        try {
            const response = await fetch(`${this.baseUrl}/api/sessions`);
            if (!response.ok) return;
            const data = await response.json();
            this.sessions = data.sessions || [];
            this.activeSessionKey = data.activeKey;
            // Adopt the server's choice only until the user makes one
            if (!this.selectedSessionKey) {
                this.selectedSessionKey = data.activeKey;
            }

            for (const session of this.sessions) {
                if (session.key !== this.selectedSessionKey && session.pendingCount > 0) {
                    this.unreadCounts[session.key] = session.pendingCount;
                }
            }

            this.checkTargetDrift();
            this.renderSessionList();
            this.render();
        } catch (error) {
            this.debugLog('Failed to load sessions:', error);
        }
    }

    // Problem 7 (and the wrong-session bug) — say plainly when the server
    // is sending your voice somewhere other than where you pointed it.
    checkTargetDrift() {
        if (!this.targetDrifted) {
            this.clearAlert('drift');
            return;
        }
        const server = this.sessions.find(s => s.key === this.activeSessionKey);
        const mine = this.sessions.find(s => s.key === this.selectedSessionKey);
        this.setAlert('drift', {
            tone: 'warn',
            title: 'Your voice is going to a different session',
            detail: `You picked ${mine ? this.describeSession(mine) : 'a session that has ended'}, but the server is currently sending speech to ${server ? this.describeSession(server) : 'another session'}.`,
            actions: [
                {
                    label: 'Send it back to mine',
                    run: () => this.switchActiveSession(this.selectedSessionKey),
                },
                {
                    label: 'Use the server\'s',
                    quiet: true,
                    run: () => this.switchActiveSession(this.activeSessionKey),
                },
            ],
        });
    }

    describeSession(session) {
        if (!session) return 'unknown session';
        if (session.agentId) {
            return session.agentType || session.agentId || 'sub-agent';
        }
        return this.formatSessionLabel(session.sessionId);
    }

    renderSessionList() {
        if (!this.sessionList) return;

        if (this.sessions.length === 0) {
            this.sessionList.innerHTML = '<div class="session-empty">No sessions connected</div>';
            return;
        }

        // Hide the placeholder session once real ones exist, unless it is
        // selected or still holds messages
        const hasRealSessions = this.sessions.some(s => s.sessionId !== 'default');
        const visibleSessions = hasRealSessions
            ? this.sessions.filter(s => {
                if (s.sessionId === 'default') {
                    return s.key === this.selectedSessionKey || (s.messageCount || 0) > 0 || s.utteranceCount > 0;
                }
                return true;
            })
            : this.sessions;

        const groups = {};
        for (const session of visibleSessions) {
            const sid = session.sessionId;
            if (!groups[sid]) groups[sid] = [];
            groups[sid].push(session);
        }

        let html = '';
        for (const [sessionId, members] of Object.entries(groups)) {
            html += '<div class="session-group">';
            // Main agent first, then sub-agents
            members.sort((a, b) => {
                if (!a.agentId && b.agentId) return -1;
                if (a.agentId && !b.agentId) return 1;
                return 0;
            });

            for (const session of members) {
                const isActive = session.key === this.selectedSessionKey;
                const isSubAgent = !!session.agentId;
                const label = isSubAgent
                    ? (session.agentType || session.agentId || 'sub-agent')
                    : this.formatSessionLabel(sessionId);
                const unread = this.unreadCounts[session.key] || 0;

                const classes = ['session-item'];
                if (isActive) classes.push('active');
                if (isSubAgent) classes.push('sub-agent');

                html += `<div class="${classes.join(' ')}" role="button" tabindex="0"`;
                html += ` data-session-key='${session.key.replace(/'/g, '&#39;')}'`;
                html += ` aria-current="${isActive ? 'true' : 'false'}"`;
                html += ` title="${this.escapeHtml(session.key)}">`;
                html += `<span class="session-label">${this.escapeHtml(label)}</span>`;
                if (unread > 0 && !isActive) {
                    html += `<span class="session-badge">${unread}</span>`;
                } else if (session.pendingCount > 0) {
                    html += `<span class="session-meta">${session.pendingCount} waiting</span>`;
                }
                if (isActive) {
                    html += '<svg class="session-check" viewBox="0 0 24 24" aria-hidden="true">';
                    html += '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
                }
                html += '</div>';
            }
            html += '</div>';
        }

        this.sessionList.innerHTML = html;
    }

    formatSessionLabel(sessionId) {
        if (sessionId === 'default') {
            const hasReal = this.sessions.some(s => s.sessionId !== 'default');
            return hasReal ? 'Unattached' : 'Main session';
        }
        if (sessionId.length > 16) return sessionId.substring(0, 8);
        return sessionId;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Point voice at a session.
     *
     * The WebSocket message only lands when the socket is open, and it is
     * closed whenever the microphone is off — so on its own, tapping a
     * session while idle changed nothing on the server. The REST call works
     * either way, which is what actually makes the choice stick.
     */
    async switchActiveSession(key) {
        if (!key) return;
        this.selectedSessionKey = key;

        if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(JSON.stringify({ type: 'select-session', sessionKey: key }));
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/active-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            });
            if (response.ok) {
                const data = await response.json();
                this.activeSessionKey = data.activeKey;
            }
        } catch (error) {
            this.debugLog('Failed to set active session:', error);
        }

        delete this.unreadCounts[key];
        this.clearInterim();
        // Drop the old session's messages so the new one's replace them
        this.conversationMessages.querySelectorAll('.message-bubble').forEach(el => el.remove());
        this.checkTargetDrift();
        this.loadData();
        this.renderSessionList();
        this.render();
    }

    // ═══════════════════════════════════════════════════════════════
    // Preferences
    // ═══════════════════════════════════════════════════════════════

    loadPreferences() {
        const savedRate = localStorage.getItem('speechRate');
        if (savedRate) {
            this.speechRate = parseFloat(savedRate);
            if (this.speechRateSlider) this.speechRateSlider.value = this.speechRate.toString();
            if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        const savedRecognitionMode = localStorage.getItem('recognitionMode');
        if (savedRecognitionMode) {
            this.recognitionMode = savedRecognitionMode;
        }

        const VALID_FEEDBACK_MODES = ['continuous', 'once', 'off'];
        const savedFeedbackMode = localStorage.getItem('feedbackSoundMode');
        if (savedFeedbackMode && VALID_FEEDBACK_MODES.includes(savedFeedbackMode) && this.feedbackSoundModeSelect) {
            this.feedbackSoundModeSelect.value = savedFeedbackMode;
        } else if (savedFeedbackMode && !VALID_FEEDBACK_MODES.includes(savedFeedbackMode)) {
            // Invalid stored value — clear it so the default is used
            localStorage.removeItem('feedbackSoundMode');
        }
    }

    async checkServerRecognition() {
        try {
            const response = await fetch(`${this.baseUrl}/api/speech-recognition-available`);
            if (response.ok) {
                const data = await response.json();
                this.serverRecognitionAvailable = data.available;
            }
        } catch (error) {
            this.debugLog('Failed to check server recognition:', error);
            this.serverRecognitionAvailable = false;
        }

        // If this Mac cannot transcribe, fall back to the browser
        if (!this.serverRecognitionAvailable && this.recognitionMode === 'server') {
            this.recognitionMode = 'browser';
        }

        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.value = this.recognitionMode;
            const serverOption = this.recognitionModeSelect.querySelector('option[value="server"]');
            if (serverOption) {
                serverOption.disabled = !this.serverRecognitionAvailable;
                serverOption.textContent = this.serverRecognitionAvailable
                    ? 'On this Mac'
                    : 'On this Mac (not available)';
            }
            const browserOption = this.recognitionModeSelect.querySelector('option[value="browser"]');
            if (browserOption) {
                browserOption.disabled = !Env.browserSpeech;
                browserOption.textContent = Env.browserSpeech
                    ? 'In the browser'
                    : 'In the browser (not available)';
            }
        }

        if (this.recognitionModeHint) {
            this.recognitionModeHint.textContent = this.serverRecognitionAvailable
                ? 'This Mac can transcribe, which works in any browser.'
                : (Env.browserSpeech
                    ? 'Only this browser can transcribe on this setup.'
                    : 'Nothing available here can transcribe speech.');
        }

        this.checkRecognitionAvailability();
    }

    /** Whether the active recognition mode uses server-side transcription. */
    get useServerRecognition() {
        return this.recognitionMode === 'server' && this.serverRecognitionAvailable && this.wsConnected;
    }

    // ═══════════════════════════════════════════════════════════════
    // Event wiring
    // ═══════════════════════════════════════════════════════════════

    setupEventListeners() {
        window.addEventListener('beforeunload', () => {
            this.currentVoiceState = 'inactive';
        });

        // Any first touch anywhere is a valid gesture to unlock audio —
        // do not make the user find the right button.
        const opportunisticUnlock = async () => {
            if (this.audioPlayer.locked) {
                await this.audioPlayer.unlock();
                this.checkAudioLock();
                this.render();
            }
        };
        document.addEventListener('pointerdown', opportunisticUnlock, { capture: true, once: true });
        document.addEventListener('keydown', opportunisticUnlock, { capture: true, once: true });

        // Composer
        this.messageInput.addEventListener('keydown', (e) => this.handleTextInputKeydown(e));
        this.messageInput.addEventListener('input', () => {
            this.autoGrowTextarea();
            this.updateComposer();
        });
        this.sendBtn.addEventListener('click', () => this.sendTypedMessage());

        // The one primary control
        this.micBtn.addEventListener('click', () => this.handleMicTap());

        // Recognition mode
        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.addEventListener('change', (e) => {
                this.recognitionMode = e.target.value;
                localStorage.setItem('recognitionMode', this.recognitionMode);
            });
        }

        // Sheets
        this.settingsToggleHeader.addEventListener('click', () => {
            const open = !this.settingsContent.classList.contains('open');
            this.toggleSidebar(false);
            this.toggleSettings(open);
        });
        if (this.settingsCloseBtn) {
            this.settingsCloseBtn.addEventListener('click', () => this.toggleSettings(false));
        }
        this.scrim.addEventListener('click', () => this.closeSheets());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeSheets();
        });

        // Speech rate
        if (this.speechRateSlider) {
            this.speechRateSlider.addEventListener('input', (e) => {
                this.speechRate = parseFloat(e.target.value);
                this.speechRateInput.value = this.speechRate.toFixed(1);
                localStorage.setItem('speechRate', this.speechRate.toString());
                this.syncSelectedVoiceToServer();
            });
        }

        if (this.speechRateInput) {
            this.speechRateInput.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                    value = Math.max(0.5, Math.min(5, value));
                    this.speechRate = value;
                    this.speechRateSlider.value = value.toString();
                    this.speechRateInput.value = value.toFixed(1);
                    localStorage.setItem('speechRate', this.speechRate.toString());
                    this.syncSelectedVoiceToServer();
                }
            });
        }

        if (this.feedbackSoundModeSelect) {
            this.feedbackSoundModeSelect.addEventListener('change', (e) => {
                localStorage.setItem('feedbackSoundMode', e.target.value);
                this.syncSelectedVoiceToServer();
            });
        }

        // Test voice — server-side TTS with no side effects
        if (this.testTTSBtn) {
            this.testTTSBtn.addEventListener('click', async () => {
                if (this.audioPlayer.locked) {
                    await this.unlockAudioFromGesture();
                }
                try {
                    await fetch(`${this.baseUrl}/api/test-voice`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: 'This is Voice Mode for Claude Code. How can I help you today?' })
                    });
                } catch (error) {
                    console.error('Failed to test voice:', error);
                }
            });
        }

        if (this.rerunChecksBtn) {
            this.rerunChecksBtn.addEventListener('click', async () => {
                this.dismissed.clear();
                await this.unlockAudioFromGesture();
                this.runEnvironmentChecks();
                this.checkRecognitionAvailability();
                this.checkVoiceOutput();
                this.verifyAfterResume();
                this.toggleSettings(false);
            });
        }

        if (this.showTipsBtn) {
            this.showTipsBtn.addEventListener('click', () => {
                localStorage.removeItem('voiceHooksSeenTips');
                this.showTips();
                this.toggleSettings(false);
            });
        }

        // Problem 5 — the tab was frozen; find out what died
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                setTimeout(() => this.verifyAfterResume(), 250);
            }
        });
        window.addEventListener('pageshow', () => this.verifyAfterResume());
        window.addEventListener('online', () => this.render());
        window.addEventListener('offline', () => { this.lastFetchOk = false; this.render(); });
    }

    handleMicTap() {
        if (this.blockedReason) {
            // Never a dead control — restate the reason and the fix
            this.dismissed.delete('blocked');
            this.applyBlockedAlert();
            return;
        }
        if (this.suspended) {
            this.resumeVoice();
            return;
        }
        if (this.isListening) {
            this.stopVoiceDictation();
            return;
        }
        this.startVoiceDictation();
    }

    updateComposer() {
        const hasText = this.messageInput.value.trim().length > 0;
        this.sendBtn.disabled = !hasText || this.isInterimText;
    }

    // ═══════════════════════════════════════════════════════════════
    // Conversation
    // ═══════════════════════════════════════════════════════════════

    async loadData() {
        try {
            const sessionParam = this.selectedSessionKey
                ? `&session=${encodeURIComponent(this.selectedSessionKey)}`
                : '';
            const conversationResponse = await fetch(`${this.baseUrl}/api/conversation?limit=50${sessionParam}`);
            if (conversationResponse.ok) {
                const data = await conversationResponse.json();
                this.lastFetchOk = true;
                this.updateConversation(data.messages);
            } else {
                this.lastFetchOk = false;
            }
        } catch (error) {
            this.lastFetchOk = false;
            console.error('Failed to load data:', error);
        }
        this.render();
    }

    /** Anything new goes above the interim bubble and the waiting pill. */
    insertionAnchor() {
        return this.conversationMessages.querySelector('.interim-bubble') || this.waitingIndicator;
    }

    updateConversation(messages) {
        const container = this.conversationMessages;
        const emptyState = container.querySelector('.empty-state');

        if (messages.length === 0) {
            if (emptyState) emptyState.style.display = 'flex';
            container.querySelectorAll('.message-bubble').forEach(el => el.remove());
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        const existingIds = new Set();
        container.querySelectorAll('.message-bubble').forEach(bubble => {
            if (bubble.dataset.messageId) existingIds.add(bubble.dataset.messageId);
        });

        const wasAtBottom = this.isUserNearBottom();

        messages.forEach(message => {
            if (!existingIds.has(message.id)) {
                const bubble = this.createMessageBubble(message);
                const anchor = this.insertionAnchor();
                if (anchor) {
                    container.insertBefore(bubble, anchor);
                } else {
                    container.appendChild(bubble);
                }
            } else if (message.role === 'user' && message.status) {
                const bubble = container.querySelector(`[data-message-id="${message.id}"]`);
                if (!bubble) return;
                const statusEl = bubble.querySelector('.message-status');
                if (!statusEl) return;

                const wasPending = statusEl.classList.contains('pending');
                const isPending = message.status === 'pending';
                if (wasPending && !isPending) {
                    const deleteBtn = statusEl.querySelector('.delete-message-btn');
                    if (deleteBtn) deleteBtn.remove();
                }

                statusEl.className = `message-status ${message.status}`;
                const statusText = statusEl.querySelector('span:last-child');
                if (statusText) statusText.textContent = this.statusWord(message.status);
            }
        });

        if (wasAtBottom) this.scrollToBottom();
    }

    /** Plain words beat status codes. */
    statusWord(status) {
        const words = { pending: 'Waiting', delivered: 'Delivered', responded: 'Answered' };
        return words[status] || status;
    }

    createMessageBubble(message) {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${message.role}`;
        bubble.dataset.messageId = message.id;

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = message.text;

        const messageMeta = document.createElement('div');
        messageMeta.className = 'message-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = this.formatTimestamp(message.timestamp);
        messageMeta.appendChild(timestamp);

        if (message.role === 'user' && message.status) {
            const statusContainer = document.createElement('div');
            statusContainer.className = `message-status ${message.status}`;

            // Pending messages can still be pulled back
            if (message.status === 'pending') {
                const deleteBtn = document.createElement('span');
                deleteBtn.className = 'delete-message-btn';
                deleteBtn.setAttribute('role', 'button');
                deleteBtn.setAttribute('tabindex', '0');
                deleteBtn.setAttribute('aria-label', 'Delete this message');
                deleteBtn.innerHTML = `
                    <svg class="delete-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                `;
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.deleteMessage(message.id);
                };
                statusContainer.appendChild(deleteBtn);
            }

            const statusText = document.createElement('span');
            statusText.textContent = this.statusWord(message.status);
            statusContainer.appendChild(statusText);

            messageMeta.appendChild(statusContainer);
        }

        bubble.appendChild(messageText);
        bubble.appendChild(messageMeta);

        return bubble;
    }

    // ── Interim transcription ──────────────────────────────────────
    // Kept visually apart from anything that has actually been sent.
    showInterim(text) {
        if (!text) { this.clearInterim(); return; }
        let el = this.conversationMessages.querySelector('.interim-bubble');
        if (!el) {
            el = document.createElement('div');
            el.className = 'interim-bubble';
            el.setAttribute('aria-live', 'off');
            el.dataset.caption = 'Still speaking…';
            const anchor = this.waitingIndicator;
            if (anchor) {
                this.conversationMessages.insertBefore(el, anchor);
            } else {
                this.conversationMessages.appendChild(el);
            }
            const emptyState = this.conversationMessages.querySelector('.empty-state');
            if (emptyState) emptyState.style.display = 'none';
        }
        const wasAtBottom = this.isUserNearBottom();
        el.textContent = text;
        el.dataset.caption = 'Still speaking…';
        if (wasAtBottom) this.scrollToBottom();
    }

    clearInterim() {
        const el = this.conversationMessages.querySelector('.interim-bubble');
        if (el) el.remove();
    }

    isUserNearBottom() {
        const container = this.conversationContainer;
        return container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    }

    scrollToBottom() {
        this.conversationContainer.scrollTo({
            top: this.conversationContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    // ── Text input ─────────────────────────────────────────────────
    handleTextInputKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendTypedMessage();
        }
        // Shift+Enter allows a new line
    }

    autoGrowTextarea() {
        const textarea = this.messageInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 110) + 'px';
    }

    async sendTypedMessage() {
        const text = this.messageInput.value.trim();
        if (!text || this.isInterimText) return;

        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.updateComposer();

        await this.sendMessage(text);
    }

    async sendMessage(text, sessionKey) {
        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    timestamp: new Date().toISOString(),
                    session: sessionKey || this.selectedSessionKey,
                })
            });

            if (response.ok) {
                this.lastFetchOk = true;
                this.loadData();
            }
        } catch (error) {
            this.lastFetchOk = false;
            console.error('Failed to send message:', error);
        }
    }

    async deleteMessage(messageId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/utterances/${messageId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                const bubble = this.conversationMessages.querySelector(`[data-message-id="${messageId}"]`);
                if (bubble) bubble.remove();
                this.loadData();
            } else {
                const error = await response.json();
                console.error('Failed to delete message:', error);
                this.setAlert('delete-failed', {
                    tone: 'error',
                    title: 'That message could not be taken back',
                    detail: error.error || 'Claude may have already picked it up.',
                });
            }
        } catch (error) {
            console.error('Failed to delete message:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Voice dictation
    // ═══════════════════════════════════════════════════════════════

    async startVoiceDictation() {
        try {
            if (this.isInterimText) {
                this.messageInput.value = '';
                this.isInterimText = false;
                this.clearInterim();
            }

            this.isListening = true;
            this.starting = true;
            this.suspended = false;
            this.micBtn.classList.add('listening');
            this.render();

            // Unlock playback on this user gesture (iOS Safari requirement)
            const unlocked = await this.audioPlayer.unlock();
            this.checkAudioLock();
            if (unlocked) this.audioPlayer.chime();

            // Open the WebSocket; capture starts from its onopen callback
            this.connectAudioWebSocket();

            // Browser recognition only when the server is not doing it
            if (!this.useServerRecognition && this.recognition) {
                try {
                    this.recognition.start();
                } catch (e) {
                    this.debugLog('Recognition already started:', e);
                }
            }

            // Turn on voice input and replies together
            await this.updateVoiceActive(true);
            this.checkVoiceOutput();
        } catch (e) {
            console.error('Failed to start recognition:', e);
            this.isListening = false;
            this.setAlert('start-failed', {
                tone: 'error',
                title: 'Could not start listening',
                detail: e && e.message ? e.message : 'Try again, or reload the page.',
                actions: [{ label: 'Try again', run: () => { this.clearAlert('start-failed'); this.startVoiceDictation(); } }],
            });
        } finally {
            this.starting = false;
            this.startLevelLoop();
            this.render();
        }
    }

    /** Shut voice down without sending anything — used when resuming. */
    async teardownVoice() {
        this.isListening = false;
        if (this.recognition) {
            try { this.recognition.stop(); } catch (_e) { /* not running */ }
        }
        this.micBtn.classList.remove('listening');
        this.isInterimText = false;
        this.clearInterim();
        this.stopAudioCapture();
        this.disconnectAudioWebSocket();
        this.stopLevelLoop();
        await this.updateVoiceActive(false);
    }

    async stopVoiceDictation() {
        this.isListening = false;
        if (this.recognition) {
            try { this.recognition.stop(); } catch (_e) { /* not running */ }
        }
        this.micBtn.classList.remove('listening');

        // Send whatever browser recognition left in the box
        const text = this.messageInput.value.trim();
        if (text && !this.isInterimText) {
            await this.sendMessage(text);
            this.messageInput.value = '';
        }

        this.isInterimText = false;
        this.clearInterim();
        this.messageInput.style.height = 'auto';
        this.updateComposer();

        this.stopAudioCapture();
        this.disconnectAudioWebSocket();
        this.stopLevelLoop();

        // Turn off voice input and replies together
        await this.updateVoiceActive(false);
        this.clearAlert('voice-off');
        this.render();
    }

    initializeSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            // Not an error on its own — this Mac may be doing the transcribing.
            this.debugLog('Browser speech recognition not supported');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
            // Ignore browser results while the server is transcribing
            if (this.useServerRecognition) return;

            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    this.isInterimText = false;
                    const finalText = this.messageInput.value.trim();
                    this.sendMessage(finalText);
                    this.messageInput.value = '';
                    this.clearInterim();
                    this.updateComposer();
                } else {
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                this.messageInput.value = interimTranscript;
                this.isInterimText = true;
                this.autoGrowTextarea();
                this.updateComposer();
                this.showInterim(interimTranscript);
            }
        };

        this.recognition.onerror = (event) => {
            if (event.error === 'no-speech') return;
            console.error('Speech error:', event.error);
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                this.blockedReason = {
                    short: 'Microphone blocked',
                    title: 'The browser blocked the microphone',
                    detail: 'Allow microphone access for this page in your browser settings, then tap the microphone again.',
                };
                this.applyBlockedAlert();
            }
            this.stopVoiceDictation();
        };

        this.recognition.onend = () => {
            // Restart only while listening and not using the server
            if (this.isListening && !this.useServerRecognition) {
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error('Failed to restart recognition:', e);
                    this.stopVoiceDictation();
                }
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // Server sync
    // ═══════════════════════════════════════════════════════════════

    async updateVoiceActive(active) {
        try {
            const response = await fetch(`${this.baseUrl}/api/voice-active`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active })
            });
            if (response.ok) {
                // The server answers with what it actually did — believe that,
                // not what we asked for.
                const data = await response.json();
                this.serverVoiceActive = !!data.voiceActive;
                this.lastFetchOk = true;
            }
        } catch (error) {
            this.lastFetchOk = false;
            console.error('Failed to update voice active state:', error);
        }
        this.checkVoiceOutput();
        this.render();
    }

    async syncSelectedVoiceToServer() {
        try {
            await fetch(`${this.baseUrl}/api/selected-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selectedVoice: 'system',
                    speechRate: Math.round(this.speechRate * 200),
                    feedbackSoundMode: this.feedbackSoundModeSelect ? this.feedbackSoundModeSelect.value : 'continuous'
                })
            });
        } catch (error) {
            this.debugLog('Failed to sync selected voice to server:', error);
        }
    }

    async syncVoiceStateToServer() {
        // Re-send the browser's voice state after a session reset
        await this.updateVoiceActive(this.isListening);
        await this.syncSelectedVoiceToServer();
    }

    async loadBackgroundEnforcement() {
        try {
            const response = await fetch(`${this.baseUrl}/api/background-voice-enforcement`);
            if (response.ok) {
                const data = await response.json();
                if (this.backgroundEnforcementToggle) {
                    this.backgroundEnforcementToggle.checked = data.enabled;
                }
                localStorage.setItem('backgroundVoiceEnforcement', data.enabled.toString());
            }
        } catch (error) {
            this.debugLog('Failed to load background enforcement:', error);
        }
    }

    async updateBackgroundEnforcement(enabled) {
        try {
            localStorage.setItem('backgroundVoiceEnforcement', enabled.toString());
            await fetch(`${this.baseUrl}/api/background-voice-enforcement`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
        } catch (error) {
            console.error('Failed to update background enforcement:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Tappable questions
    //
    // When Claude needs a decision, the terminal's own option picker is
    // useless from a phone — you cannot reach it. So Claude drops a
    // question document next to this page instead, and the answer travels
    // back the same way everything else does: as a message.
    // ═══════════════════════════════════════════════════════════════

    async pollQuestion() {
        let doc = null;
        try {
            const response = await fetch(`${this.baseUrl}/question.json?t=${Date.now()}`, { cache: 'no-store' });
            if (response.ok) doc = await response.json();
        } catch (_e) {
            // No question waiting — that is the normal case
        }

        if (!doc || !doc.id || !Array.isArray(doc.questions) || doc.questions.length === 0) {
            this.hideQuestion();
            return;
        }
        if (doc.id === localStorage.getItem('answeredQuestionId')) {
            this.hideQuestion();
            return;
        }
        if (doc.expiresAt && Date.parse(doc.expiresAt) < Date.now()) {
            this.hideQuestion();
            return;
        }
        if (this.question && this.question.id === doc.id) return; // already on screen

        this.question = doc;
        this.answers = {};
        this.renderQuestion();
    }

    hideQuestion() {
        if (!this.question) return;
        this.question = null;
        this.answers = {};
        this.questionCard.hidden = true;
        this.questionCard.textContent = '';
    }

    renderQuestion() {
        const doc = this.question;
        const card = this.questionCard;
        card.textContent = '';
        card.hidden = false;

        const kicker = document.createElement('p');
        kicker.className = 'question-kicker';
        const kIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        kIcon.setAttribute('viewBox', '0 0 24 24');
        kIcon.setAttribute('aria-hidden', 'true');
        const kPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        kPath.setAttribute('d', 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m1 17h-2v-2h2zm1.9-7.1-.9.9A2.5 2.5 0 0 0 13 15h-2v-.5a3.5 3.5 0 0 1 1-2.4l1.2-1.3A2 2 0 1 0 10 9H8a4 4 0 1 1 6.9 2.9');
        kIcon.appendChild(kPath);
        kicker.appendChild(kIcon);
        kicker.appendChild(document.createTextNode(
            doc.questions.length > 1 ? `Claude needs ${doc.questions.length} answers` : 'Claude needs an answer'));
        card.appendChild(kicker);

        doc.questions.forEach((q, qi) => {
            const block = document.createElement('div');
            block.className = 'question-block';

            const text = document.createElement('p');
            text.className = 'question-text';
            text.textContent = q.question || q.header || 'Pick one';
            block.appendChild(text);

            const list = document.createElement('div');
            list.className = 'question-options';
            list.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
            list.setAttribute('aria-label', q.question || q.header || 'Options');

            (q.options || []).forEach(option => {
                const label = typeof option === 'string' ? option : option.label;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'question-option';
                btn.dataset.multi = q.multiSelect ? 'true' : 'false';
                btn.setAttribute('aria-pressed', 'false');

                const marker = document.createElement('span');
                marker.className = 'question-marker';
                marker.setAttribute('aria-hidden', 'true');
                btn.appendChild(marker);

                const body = document.createElement('span');
                body.className = 'question-option-body';
                const labelEl = document.createElement('span');
                labelEl.className = 'question-option-label';
                labelEl.textContent = label;
                body.appendChild(labelEl);
                if (option && option.description) {
                    const desc = document.createElement('span');
                    desc.className = 'question-option-desc';
                    desc.textContent = option.description;
                    body.appendChild(desc);
                }
                btn.appendChild(body);

                btn.addEventListener('click', () => this.toggleAnswer(qi, label, !!q.multiSelect, list, btn));
                list.appendChild(btn);
            });

            block.appendChild(list);
            card.appendChild(block);
        });

        const actions = document.createElement('div');
        actions.className = 'question-actions';

        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'question-send';
        send.id = 'questionSend';
        send.textContent = 'Send answer';
        send.disabled = true;
        send.addEventListener('click', () => this.submitAnswer());
        actions.appendChild(send);

        const other = document.createElement('button');
        other.type = 'button';
        other.className = 'question-other';
        other.textContent = 'Something else';
        other.addEventListener('click', () => {
            this.dismissQuestion();
            this.messageInput.focus();
        });
        actions.appendChild(other);
        card.appendChild(actions);

        // The answer goes to the session that asked, not to whatever this
        // page happens to be pointed at — that mismatch is the whole bug.
        if (doc.sessionKey && doc.sessionKey !== this.selectedSessionKey) {
            const note = document.createElement('p');
            note.className = 'question-elsewhere';
            const asker = this.sessions.find(s => s.key === doc.sessionKey);
            note.textContent = `This was asked by ${asker ? this.describeSession(asker) : 'another session'}. Your answer goes there, not to the session shown above.`;
            card.appendChild(note);
        }
    }

    toggleAnswer(qi, label, multi, list, btn) {
        const current = this.answers[qi] || [];
        if (multi) {
            this.answers[qi] = current.includes(label)
                ? current.filter(l => l !== label)
                : current.concat(label);
        } else {
            this.answers[qi] = current.includes(label) ? [] : [label];
            list.querySelectorAll('.question-option').forEach(el => el.setAttribute('aria-pressed', 'false'));
        }
        const chosen = this.answers[qi] || [];
        if (multi) {
            btn.setAttribute('aria-pressed', chosen.includes(label) ? 'true' : 'false');
        } else {
            btn.setAttribute('aria-pressed', chosen.includes(label) ? 'true' : 'false');
        }

        const send = document.getElementById('questionSend');
        if (send) {
            const answeredAll = this.question.questions.every((_q, i) => (this.answers[i] || []).length > 0);
            send.disabled = !answeredAll;
        }
    }

    async submitAnswer() {
        if (!this.question) return;
        const doc = this.question;
        const parts = doc.questions.map((q, i) => {
            const chosen = this.answers[i] || [];
            const head = q.header || q.question || `Answer ${i + 1}`;
            return `${head}: ${chosen.join(', ')}`;
        });

        localStorage.setItem('answeredQuestionId', doc.id);
        this.hideQuestion();

        await this.sendMessage(parts.join(' | '), doc.sessionKey || this.selectedSessionKey);
    }

    dismissQuestion() {
        if (!this.question) return;
        localStorage.setItem('answeredQuestionId', this.question.id);
        this.hideQuestion();
    }

    // ═══════════════════════════════════════════════════════════════
    // WebSocket audio
    // ═══════════════════════════════════════════════════════════════

    connectAudioWebSocket() {
        if (this.audioWs && (this.audioWs.readyState === WebSocket.OPEN || this.audioWs.readyState === WebSocket.CONNECTING)) {
            return; // Already connected or connecting
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws/audio`;
        console.log('[WS] Connecting to', wsUrl);

        this.audioWs = new WebSocket(wsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = () => {
            console.log('[WS] Connected');
            this.wsConnected = true;
            this.wsReconnectDelay = 1000; // Reset backoff on success
            // Tell the server which session this browser is pointed at
            if (this.selectedSessionKey) {
                this.audioWs.send(JSON.stringify({ type: 'select-session', sessionKey: this.selectedSessionKey }));
            }
            // Start capture now that the connection is ready
            this.startAudioCapture();
            this.render();
        };

        this.audioWs.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleWsMessage(msg);
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            } else if (event.data instanceof ArrayBuffer) {
                // Binary frame = TTS audio PCM data
                if (this.audioPlayer.ttsActive) {
                    this.audioPlayer.playPCMChunk(event.data);
                }
            }
        };

        this.audioWs.onclose = () => {
            console.log('[WS] Disconnected');
            this.wsConnected = false;
            this.audioWs = null;
            // Reset playback state and unmute the mic on disconnect
            this.audioPlayer.clear();
            this._micMuted = false;
            if (this.isListening) {
                this.scheduleWsReconnect();
            }
            this.render();
        };

        this.audioWs.onerror = (err) => {
            console.error('[WS] Error:', err);
            this.render();
        };
    }

    handleWsMessage(msg) {
        switch (msg.type) {
            case 'transcript-interim':
                // Display only — the server owns the real transcript
                if (this.useServerRecognition) {
                    this.messageInput.value = msg.text;
                    this.isInterimText = true;
                    this.autoGrowTextarea();
                    this.updateComposer();
                    this.showInterim(msg.text);
                }
                break;
            case 'transcript-final':
                // The server already created the utterance — just clear up
                if (this.useServerRecognition) {
                    this.messageInput.value = '';
                    this.isInterimText = false;
                    this.messageInput.style.height = 'auto';
                    this.updateComposer();
                    this.clearInterim();
                    this.loadData();
                }
                break;
            case 'tts-start': {
                const isSfx = msg.kind === 'sfx';
                console.log('[WS] TTS start:', msg.audioId, 'sampleRate:', msg.sampleRate, 'kind:', msg.kind || 'tts');
                this.audioPlayer.prepareForPlayback(msg.sampleRate, msg.audioId);
                if (!isSfx) {
                    // Echo suppression: stop streaming mic audio during playback
                    this._muteAudioCapture(true);
                }
                this.render();
                break;
            }
            case 'tts-end': {
                const isSfx = msg.kind === 'sfx';
                this.debugLog('[WS] TTS end:', msg.audioId, 'kind:', msg.kind || 'tts');
                this.audioPlayer.finishPlayback();
                if (!isSfx) {
                    // Streaming finishes before playback does
                    this._waitForPlaybackThenAck(msg.audioId);
                }
                this.render();
                break;
            }
            case 'tts-clear':
                this.debugLog('[WS] TTS clear');
                this.audioPlayer.clear();
                this._muteAudioCapture(false);
                this.render();
                break;
            case 'pong':
                this.debugLog('[WS] Received pong');
                break;
            case 'error':
                console.error('[WS] Server error:', msg.message);
                break;
            default:
                this.debugLog('[WS] Unknown message type:', msg.type);
        }
    }

    _muteAudioCapture(mute) {
        this._micMuted = mute;
        if (!mute) this._echoStart = 0;
    }

    _waitForPlaybackThenAck(audioId) {
        // Poll until playback is genuinely finished, then tell the server
        // and re-open the microphone.
        const checkDone = () => {
            if (!this.audioPlayer.isPlaying()) {
                if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                    this.audioWs.send(JSON.stringify({ type: 'tts-ack', audioId }));
                }
                this._muteAudioCapture(false);
                this.render();
            } else {
                setTimeout(checkDone, 100);
            }
        };
        setTimeout(checkDone, 100);
    }

    scheduleWsReconnect() {
        if (this.wsReconnectTimer) return;
        this.debugLog(`[WS] Reconnecting in ${this.wsReconnectDelay}ms`);
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            if (this.isListening) {
                this.connectAudioWebSocket();
            }
        }, this.wsReconnectDelay);
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
    }

    disconnectAudioWebSocket() {
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        if (this.audioWs) {
            this.audioWs.close();
            this.audioWs = null;
        }
        this.wsConnected = false;
    }

    // ═══════════════════════════════════════════════════════════════
    // Microphone capture
    // ═══════════════════════════════════════════════════════════════

    async startAudioCapture() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                }
            });
            this.mediaStream = stream;

            // If the OS takes the mic away, say so instead of going deaf
            stream.getAudioTracks().forEach(track => {
                track.addEventListener('ended', () => {
                    if (this.isListening) this.verifyAfterResume();
                });
                track.addEventListener('mute', () => this.render());
                track.addEventListener('unmute', () => this.render());
            });

            // Native rate — the worklet handles downsampling
            this.audioContext = new AudioContext();
            await this.audioContext.resume(); // Required on iOS after a gesture

            const source = this.audioContext.createMediaStreamSource(stream);
            await this.audioContext.audioWorklet.addModule('/audio-capture-worklet.js');

            this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
            this.audioWorkletNode.port.onmessage = (e) => {
                if (e.data.type !== 'audio-frame') return;
                const float32 = e.data.frame;

                // Level first — it drives the meter and the echo detector, and
                // must be measured even while the mic is muted for playback.
                this.observeLevel(float32);

                if (!this.audioWs || this.audioWs.readyState !== WebSocket.OPEN || this._micMuted) return;

                // Convert Float32 [-1,1] to Int16 PCM
                const pcm16 = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.audioWs.send(pcm16.buffer);
            };

            source.connect(this.audioWorkletNode);
            // Route through a silent gain node so the worklet keeps running
            // without playing captured audio out of the speakers
            const silentGain = this.audioContext.createGain();
            silentGain.gain.value = 0;
            this.audioWorkletNode.connect(silentGain);
            silentGain.connect(this.audioContext.destination);

            if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                this.audioWs.send(JSON.stringify({
                    type: 'audio-start',
                    sampleRate: 16000,
                    channels: 1,
                    encoding: 'pcm16',
                }));
            }

            const micBlocks = ['Microphone blocked', 'No microphone', 'No microphone access'];
            if (this.blockedReason && micBlocks.includes(this.blockedReason.short)) {
                this.blockedReason = null;
                this.applyBlockedAlert();
            }
            this.debugLog('[Audio] Capture started, native rate:', this.audioContext.sampleRate);
        } catch (err) {
            console.error('[Audio] Failed to start capture:', err);
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                this.blockedReason = {
                    short: 'Microphone blocked',
                    title: 'This page is not allowed to use the microphone',
                    detail: 'Allow microphone access for this site in your browser settings, then tap the microphone again.',
                };
            } else if (err && err.name === 'NotFoundError') {
                this.blockedReason = {
                    short: 'No microphone',
                    title: 'No microphone was found',
                    detail: 'Plug one in, or check that another app has not taken it.',
                };
            } else {
                this.setAlert('capture-failed', {
                    tone: 'error',
                    title: 'The microphone did not start',
                    detail: err && err.message ? err.message : 'Try tapping the microphone again.',
                });
            }
            this.isListening = false;
            this.micBtn.classList.remove('listening');
            this.applyBlockedAlert();
        }
        this.render();
    }

    /** Smoothed input level — fast attack so speech shows immediately. */
    observeLevel(float32) {
        let sum = 0;
        for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
        const rms = Math.sqrt(sum / float32.length);

        const scaled = Math.min(1, rms * 6);
        this.level = scaled > this.level ? scaled : this.level * 0.85 + scaled * 0.15;

        // Problem 4 — Claude's own voice looping back through the speakers
        if (this._micMuted && this.audioPlayer.isPlaying()) {
            if (rms > ECHO_RMS_THRESHOLD) {
                if (!this._echoStart) {
                    this._echoStart = Date.now();
                } else if (Date.now() - this._echoStart > ECHO_SUSTAIN_MS) {
                    this.reportEcho();
                }
            } else {
                this._echoStart = 0;
            }
        }
    }

    startLevelLoop() {
        if (this._levelRaf) return;
        const tick = () => {
            if (!this.isListening) { this._levelRaf = null; return; }
            this.level *= 0.95;
            this.micDock.style.setProperty('--level', this.level.toFixed(3));
            if (this.micDock.dataset.state !== this.micState) this.render();
            this._levelRaf = requestAnimationFrame(tick);
        };
        this._levelRaf = requestAnimationFrame(tick);
    }

    stopLevelLoop() {
        if (this._levelRaf) {
            cancelAnimationFrame(this._levelRaf);
            this._levelRaf = null;
        }
        this.level = 0;
        this.micDock.style.setProperty('--level', '0');
    }

    stopAudioCapture() {
        if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(JSON.stringify({ type: 'audio-stop' }));
        }

        if (this.audioWorkletNode) {
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => { });
            this.audioContext = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        this.debugLog('[Audio] Capture stopped');
    }
}

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new MessengerClient();
});
