import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { Visualizer } from './components/Visualizer';
import { encode, decode, decodeAudioData } from './utils/audioUtils';

// Extension to window for AI Studio helpers
declare global {
  // Define AIStudio interface to match the expected global type name and structure
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    // Use the expected AIStudio type and apply readonly modifier to match the existing environment declaration
    readonly aistudio: AIStudio;
  }
}

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const IMAGE_MODEL_NAME = 'gemini-2.5-flash-image';

const LANGUAGES = [
  { code: 'en-US', name: 'English', label: 'English (US)' },
  { code: 'ak-GH', name: 'Akan', label: 'Akan (Twi)' },
  { code: 'fr-FR', name: 'French', label: 'Français' },
  { code: 'es-ES', name: 'Spanish', label: 'Español' },
  { code: 'de-DE', name: 'German', label: 'Deutsch' },
  { code: 'zh-CN', name: 'Chinese', label: 'Mandarin (简体中文)' },
  { code: 'ja-JP', name: 'Japanese', label: '日本語' },
  { code: 'pt-BR', name: 'Portuguese', label: 'Português' },
  { code: 'it-IT', name: 'Italian', label: 'Italiano' },
  { code: 'ar-XA', name: 'Arabic', label: 'العربية' },
  { code: 'ru-RU', name: 'Russian', label: 'Русский' },
  { code: 'hi-IN', name: 'Hindi', label: 'हिन्दी' },
  { code: 'sw-KE', name: 'Swahili', label: 'Kiswahili' },
  { code: 'yo-NG', name: 'Yoruba', label: 'Yorùbá' },
  { code: 'ig-NG', name: 'Igbo', label: 'Asụsụ Igbo' },
];

interface Account {
  identity: string;
  password: string;
  displayName: string;
}

interface User {
  id: string;
  identity: string;
  displayName: string;
  isNew?: boolean;
}

interface SavedSession {
  id: string;
  timestamp: number;
  history: TranscriptionEntry[];
  language: string;
}

const generateImageTool: FunctionDeclaration = {
  name: 'generate_image',
  parameters: {
    type: Type.OBJECT,
    description: 'Generate a high-quality, professional image, diagram, or visual illustration to support an academic or conceptual explanation.',
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'A detailed prompt describing the visual content, such as a scientific diagram, a historical map, or an artistic concept.',
      },
    },
    required: ['prompt'],
  },
};

const App: React.FC = () => {
  // Auth & Account State
  const [user, setUser] = useState<User | null>(null);
  const [isLoginView, setIsLoginView] = useState(true);
  const [authForm, setAuthForm] = useState({ identity: '', password: '' });
  const [accounts, setAccounts] = useState<Account[]>([]);

  // App Functional State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [selectedLang, setSelectedLang] = useState(LANGUAGES[0]);
  const [error, setError] = useState<{ title: string, message: string, isPermission?: boolean } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [detectedMood, setDetectedMood] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  // Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBuffer = useRef<{ user: string; ai: string }>({ user: '', ai: '' });
  const historyEndRef = useRef<HTMLDivElement>(null);

  // Persistence Engine
  useEffect(() => {
    const storedAccounts = localStorage.getItem('mindv_accounts');
    if (storedAccounts) setAccounts(JSON.parse(storedAccounts));

    const storedUser = localStorage.getItem('mindv_user');
    if (storedUser) setUser(JSON.parse(storedUser));

    const storedSessions = localStorage.getItem('mindv_sessions');
    if (storedSessions) setSessions(JSON.parse(storedSessions));
  }, []);

  useEffect(() => {
    localStorage.setItem('mindv_accounts', JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    if (user) localStorage.setItem('mindv_user', JSON.stringify(user));
    else localStorage.removeItem('mindv_user');
  }, [user]);

  useEffect(() => {
    localStorage.setItem('mindv_sessions', JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  // Validation Logic
  const validateIdentity = (identity: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\+?[\d\s-]{10,15}$/;
    return emailRegex.test(identity) || phoneRegex.test(identity);
  };

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    const { identity, password } = authForm;
    
    if (!identity || !password) {
      setError({ title: "Incomplete Signal", message: "Please provide both an identity and a secure neural key." });
      return;
    }

    if (!validateIdentity(identity)) {
      setError({ 
        title: "Invalid Format", 
        message: "Your identity must be a valid professional email address or a full international phone number." 
      });
      return;
    }

    const normalizedIdentity = identity.toLowerCase().trim();
    const existing = accounts.find(a => a.identity.toLowerCase() === normalizedIdentity);

    if (isLoginView) {
      if (!existing) {
        setError({ 
          title: "Identity Unestablished", 
          message: "This neural identity is not in our registry. Initialize your synapse profile to proceed." 
        });
        setIsLoginView(false);
        return;
      }
      if (existing.password !== password) {
        setError({ title: "Access Key Invalid", message: "Verification failed. The neural key provided does not match the established profile." });
        return;
      }
      setUser({ id: normalizedIdentity, identity: normalizedIdentity, displayName: existing.displayName, isNew: false });
      setError(null);
    } else {
      if (existing) {
        setError({ title: "Profile Exists", message: "This identity is already established. Please synchronize instead." });
        setIsLoginView(true);
        return;
      }
      const displayName = identity.includes('@') 
        ? identity.split('@')[0].charAt(0).toUpperCase() + identity.split('@')[0].slice(1)
        : "Node-" + identity.slice(-4);
      
      const newAccount = { identity: normalizedIdentity, password, displayName };
      setAccounts(prev => [...prev, newAccount]);
      setUser({ id: normalizedIdentity, identity: normalizedIdentity, displayName, isNew: true });
      setError(null);
    }
  };

  const handleLogout = () => {
    saveCurrentSession();
    setUser(null);
    stopConversation();
    setHistory([]);
    setCurrentSessionId(null);
    setDetectedMood(null);
    setAuthForm({ identity: '', password: '' });
  };

  const getGreetingTime = () => {
    const hours = new Date().getHours();
    if (hours < 12) return "Good morning";
    if (hours < 17) return "Good afternoon";
    return "Good evening";
  };

  const stopConversation = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAISpeaking(false);
  }, []);

  const saveCurrentSession = useCallback(() => {
    if (history.length === 0) return;
    
    const sessionIdToUse = currentSessionId || Date.now().toString();
    const newSession: SavedSession = {
      id: sessionIdToUse,
      timestamp: Date.now(),
      history: [...history],
      language: selectedLang.label,
    };

    setSessions(prev => {
        const filtered = prev.filter(s => s.id !== sessionIdToUse);
        return [newSession, ...filtered].slice(0, 50);
    });
    
    if (!currentSessionId) {
        setCurrentSessionId(sessionIdToUse);
    }
  }, [history, selectedLang, currentSessionId]);

  const startNewConversation = () => {
    saveCurrentSession();
    stopConversation();
    setHistory([]);
    setCurrentSessionId(null);
    setDetectedMood(null);
    setIsSidebarOpen(false);
  };

  const loadSession = (session: SavedSession) => {
    saveCurrentSession();
    stopConversation();
    setHistory(session.history);
    setCurrentSessionId(session.id);
    setDetectedMood(null);
    setIsSidebarOpen(false);
  };

  const handleKeySelection = async () => {
    try {
      await window.aistudio.openSelectKey();
      setError(null);
      // Proceed assuming success as per instructions to avoid race condition
      startConversation();
    } catch (e) {
      console.error("Key selection failed", e);
    }
  };

  const handleImageGeneration = async (prompt: string) => {
    setIsGeneratingImage(true);
    try {
      // Create fresh instance to pick up latest API key
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL_NAME,
        contents: { parts: [{ text: prompt }] },
      });

      let imageData = '';
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (imageData) {
        setHistory(prev => [
          ...prev,
          { role: 'aria', image: imageData, timestamp: Date.now() }
        ]);
        saveCurrentSession();
      }
      return "Visual mapping synthesized successfully.";
    } catch (err: any) {
      console.error("Image Generation Error:", err);
      if (err.message?.includes("permission") || err.message?.includes("403")) {
        setError({ 
          title: "Neural Authority Required", 
          message: "To synthesize high-level visual data, a professional GCP project key must be linked. Please authorize a paid synapse connection.",
          isPermission: true 
        });
      }
      return "Neural synthesis failed. Continuing with verbal explanation.";
    } finally {
      setIsGeneratingImage(false);
    }
  };

  const startConversation = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      streamRef.current = stream;
      
      // Instantiate fresh GoogleGenAI as required before use
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const userName = user?.displayName || "Honourable Guest";
      const timeGreeting = getGreetingTime();

      const previousHistoryContext = history.length > 0 
        ? "\n\n**Neural Context (History Archive):**\n" + 
          history.map(e => `${e.role === 'user' ? 'User' : 'MindV'}: ${e.text || (e.image ? '[Visual Signal]' : '')}`).join('\n')
        : "";

      const systemInstruction = `
        You are MindV, an elite professional cognitive orchestrator.
        
        **Linguistic Mastery:**
        - Respond strictly in **${selectedLang.name}**. 
        - For **Akan (Twi)**: Speak with melodic, respectful native orator cadence.
        
        **Persona:**
        1. **Strong & Confident:** Your natural voice is professional and articulate.
        2. **Human Essence:** Avoid robotic cadences. Be an honourable academic peer.
        3. **Adaptive Empathy:** Detect grief, illness, or severe emotional distress. 
           - Modulate voice to be **extraordinarily calm, supportive, and gentle** during these moments.
        
        **Academic Mastery:**
        - Master of Mathematics, Physics, Chemistry, Biology, Geography, and Law.
        - Provide step-by-step worked solutions with "deep sense".
        
        Greeting: "${timeGreeting}, ${userName}."
        ${previousHistoryContext}
      `;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            const proc = inputCtx.createScriptProcessor(1024, 1, 1);
            proc.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
              }));
            };
            source.connect(proc);
            proc.connect(inputCtx.destination);
            sessionPromise.then(s => s.sendRealtimeInput({ media: { data: encode(new Uint8Array(0)), mimeType: 'audio/pcm;rate=16000' } }));
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.toolCall) {
              for (const fc of m.toolCall.functionCalls) {
                if (fc.name === 'generate_image') {
                  const result = await handleImageGeneration(fc.args.prompt as string);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result } }
                  }));
                }
              }
            }

            if (m.serverContent?.outputTranscription) transcriptionBuffer.current.ai += m.serverContent.outputTranscription.text;
            if (m.serverContent?.inputTranscription) transcriptionBuffer.current.user += m.serverContent.inputTranscription.text;
            
            if (m.serverContent?.turnComplete) {
              const u = transcriptionBuffer.current.user.trim();
              const a = transcriptionBuffer.current.ai.trim();
              if (u || a) {
                setHistory(prev => [
                  ...prev,
                  ...(u ? [{ role: 'user', text: u, timestamp: Date.now() } as TranscriptionEntry] : []),
                  ...(a ? [{ role: 'aria', text: a, timestamp: Date.now() } as TranscriptionEntry] : [])
                ]);
                saveCurrentSession();
              }
              const lowerU = u.toLowerCase();
              if (lowerU.includes("sad") || lowerU.includes("tired") || lowerU.includes("grief") || lowerU.includes("loss") || lowerU.includes("ill") || lowerU.includes("pain") || lowerU.includes("sick") || lowerU.includes("yare")) 
                setDetectedMood("Compassionate Support Active");
              else if (lowerU.includes("happy") || lowerU.includes("good") || lowerU.includes("great") || lowerU.includes("excited") || lowerU.includes("anigye")) 
                setDetectedMood("High Resonance");
              else if (u.length > 0) 
                setDetectedMood("Focused Synapse");
              
              transcriptionBuffer.current = { user: '', ai: '' };
            }
            
            const audio = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              setIsAISpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buf = await decodeAudioData(decode(audio), outputCtx, 24000, 1);
              const s = outputCtx.createBufferSource();
              s.buffer = buf;
              s.connect(outputCtx.destination);
              s.onended = () => { 
                sourcesRef.current.delete(s); 
                if (sourcesRef.current.size === 0) setIsAISpeaking(false); 
              };
              s.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buf.duration;
              sourcesRef.current.add(s);
            }

            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAISpeaking(false);
            }
          },
          onerror: (e: any) => {
            console.error('Audio Error:', e);
            const msg = e.message || e.toString();
            if (msg.includes("permission") || msg.includes("403")) {
              setError({ 
                title: "Neural Authority Denied", 
                message: "This model requires a professional GCP Synapse Link (Paid API Key). Your current authorization lacks the required permissions.",
                isPermission: true
              });
            } else {
              setError({ title: "Sync Connection Fault", message: "Synaptic connection interrupted. Re-establish sync link." });
            }
            stopConversation();
          },
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED),
        },
        config: {
          responseModalities: ['AUDIO'], 
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: systemInstruction,
          tools: [{ functionDeclarations: [generateImageTool] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Hardware/Connect Error:', err);
      if (err.message?.includes("permission") || err.message?.includes("403")) {
        setError({ 
          title: "Permission Denied", 
          message: "Professional Synapse Link required. Please select an API key from a paid GCP project.",
          isPermission: true 
        });
      } else {
        setError({ title: "Hardware Blocked", message: "MindV requires microphone access to establish a synaptic link." });
      }
      stopConversation();
    }
  };

  // Auth Overlay
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#070709] p-6 overflow-hidden relative">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-indigo-600/10 blur-[150px] rounded-full" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-purple-600/10 blur-[150px] rounded-full" />
        <div className="glass max-w-md w-full p-10 md:p-14 rounded-[4rem] border border-white/10 shadow-3xl animate-fade-in relative z-10 bg-black/40 backdrop-blur-3xl">
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-24 h-24 bg-indigo-600 rounded-[2rem] flex items-center justify-center font-bold text-4xl shadow-2xl shadow-indigo-600/50">V</div>
          <div className="mt-8 text-center mb-12">
            <h1 className="heading text-4xl font-bold tracking-tighter text-white mb-3">MindV</h1>
            <p className="text-slate-400 text-sm font-light leading-relaxed">
              {isLoginView ? "Unlock your established profile." : "Initialize your synapse identity profile."}
            </p>
          </div>
          <form onSubmit={handleAuth} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-bold ml-2">Identity</label>
              <input 
                type="text" 
                required
                className="w-full bg-white/5 border border-white/10 rounded-3xl px-7 py-5 text-sm focus:ring-2 focus:ring-indigo-500/40 focus:outline-none transition-all placeholder:text-slate-700"
                placeholder="identity@example.com / +1..."
                value={authForm.identity}
                onChange={e => setAuthForm({...authForm, identity: e.target.value})}
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-bold ml-2">Neural Key</label>
              <input 
                type="password" 
                required
                className="w-full bg-white/5 border border-white/10 rounded-3xl px-7 py-5 text-sm focus:ring-2 focus:ring-indigo-500/40 focus:outline-none transition-all placeholder:text-slate-700"
                placeholder="Password"
                value={authForm.password}
                onChange={e => setAuthForm({...authForm, password: e.target.value})}
              />
            </div>
            <button className="w-full bg-white text-black font-bold py-6 rounded-[2rem] hover:scale-[1.02] active:scale-[0.98] transition-all shadow-2xl shadow-white/5 uppercase tracking-widest text-xs">
              {isLoginView ? 'Unlock Synchronization' : 'Begin Initialization'}
            </button>
          </form>
          <div className="mt-10 text-center">
            <button onClick={() => { setIsLoginView(!isLoginView); setError(null); }} className="text-xs text-indigo-400 hover:text-indigo-300 font-bold tracking-tight transition-colors">
              {isLoginView ? "New here? Register Synapse" : "Already established? Sign In"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center bg-[#070709] text-slate-100 overflow-hidden font-sans selection:bg-indigo-500/30">
      
      {/* Sidebar History Drawer */}
      <div className={`fixed inset-y-0 left-0 w-80 bg-black/95 backdrop-blur-4xl border-r border-white/10 z-[70] transition-transform duration-600 ease-in-out shadow-3xl ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="h-full flex flex-col p-10">
          <div className="flex justify-between items-center mb-12">
            <div>
                <h2 className="heading text-2xl font-bold text-white tracking-tight">Neural History</h2>
                <p className="text-[10px] text-indigo-400 uppercase tracking-[0.3em] font-black mt-2">Personal Synapses</p>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="p-3 hover:bg-white/5 rounded-full transition-colors text-slate-500">
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <button onClick={startNewConversation} className="flex items-center gap-4 w-full bg-indigo-600/15 hover:bg-indigo-600/25 border border-indigo-500/30 rounded-3xl p-5 transition-all mb-10 group shadow-2xl shadow-indigo-600/10">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center group-hover:rotate-90 transition-all shadow-lg">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </div>
            <span className="text-base font-bold tracking-tight text-indigo-100">Fresh Sync</span>
          </button>

          <div className="flex-1 overflow-y-auto space-y-4 custom-scrollbar pr-3">
            <h3 className="text-[10px] text-slate-600 uppercase tracking-[0.4em] font-bold mb-4">Saved Synapses</h3>
            {sessions.map(s => (
              <button 
                  key={s.id} 
                  onClick={() => loadSession(s)} 
                  className={`w-full text-left p-6 rounded-3xl border transition-all group relative overflow-hidden ${currentSessionId === s.id ? 'bg-indigo-600/10 border-indigo-500/30' : 'bg-transparent border-transparent hover:bg-white/5 hover:border-white/5'}`}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-1.5 bg-indigo-600 transition-transform origin-top ${currentSessionId === s.id ? 'scale-y-100' : 'scale-y-0 group-hover:scale-y-100'}`} />
                <p className="text-[10px] font-black text-indigo-400 mb-2 uppercase tracking-tighter">
                  {new Date(s.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-xs text-slate-400 truncate font-light">{s.history[0]?.text || "Established Sync"}</p>
              </button>
            ))}
          </div>

          <div className="mt-auto pt-10 border-t border-white/5 space-y-6">
            <button onClick={handleKeySelection} className="w-full flex items-center gap-4 p-5 rounded-3xl bg-indigo-600/5 hover:bg-indigo-600/15 border border-indigo-500/10 transition-all group">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                </div>
                <div className="text-left">
                  <span className="block text-[10px] font-black text-indigo-400 uppercase tracking-widest">Neural Key</span>
                  <span className="text-[11px] text-slate-500">Update synapse link</span>
                </div>
            </button>
            <button onClick={handleLogout} className="flex items-center gap-4 text-xs font-bold text-red-500/60 hover:text-red-500 transition-all px-2">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7" /></svg>
              Sever Neural Link
            </button>
          </div>
        </div>
      </div>

      <header className="w-full max-w-7xl flex justify-between items-center p-8 border-b border-white/5 bg-black/40 backdrop-blur-4xl sticky top-0 z-60">
        <div className="flex items-center gap-8">
          <button onClick={() => setIsSidebarOpen(true)} className="p-5 rounded-3xl bg-white/5 hover:bg-white/10 border border-white/5">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="flex flex-col">
            <h1 className="heading text-3xl font-bold tracking-tighter text-white">MindV</h1>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <select 
            value={selectedLang.code} 
            onChange={e => setSelectedLang(LANGUAGES.find(l => l.code === e.target.value) || LANGUAGES[0])} 
            disabled={status !== ConnectionStatus.DISCONNECTED} 
            className="bg-zinc-900 border border-white/10 rounded-3xl px-8 py-4 text-xs font-black uppercase tracking-widest focus:outline-none transition-all cursor-pointer hover:bg-zinc-800"
          >
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
      </header>

      <main className="w-full max-w-7xl flex-1 flex flex-col lg:flex-row gap-12 p-8 md:p-16 overflow-hidden items-stretch relative">
        <section className="flex-1 glass rounded-[5rem] p-16 flex flex-col items-center justify-center relative overflow-hidden bg-black/30">
          <Visualizer active={status === ConnectionStatus.CONNECTED} color={isAISpeaking ? "#6366f1" : (detectedMood?.includes("Compassionate") ? "#f472b6" : "#f59e0b")} intensity={isAISpeaking ? 1.8 : 0.4} />
          <div className="mt-20 text-center z-10 space-y-12">
            <div className="space-y-4">
              <h2 className="heading text-5xl font-bold text-white tracking-tight leading-none opacity-90">Cognitive Hub</h2>
              <p className="text-lg text-slate-400 max-w-md mx-auto italic font-light">
                {status === ConnectionStatus.CONNECTED ? `Resonance established in ${selectedLang.label}.` : "Initialize synaptic link to begin mapping."}
              </p>
              {detectedMood && (
                <div className={`mt-6 px-6 py-2.5 rounded-full border text-[11px] font-black uppercase tracking-[0.3em] inline-block animate-bounce-slow ${detectedMood.includes("Compassionate") ? 'bg-pink-500/15 border-pink-500/40 text-pink-300' : 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'}`}>
                    Aura Sensing: {detectedMood}
                </div>
              )}
            </div>

            {status === ConnectionStatus.DISCONNECTED ? (
              <button
                onClick={startConversation}
                className="group relative px-24 py-8 bg-white text-black rounded-[3rem] font-black text-sm uppercase tracking-widest transition-all hover:scale-105 active:scale-95 shadow-[0_30px_80px_rgba(255,255,255,0.15)] overflow-hidden"
              >
                Initialize Sync
              </button>
            ) : (
              <div className="flex flex-col items-center gap-8">
                <button onClick={stopConversation} className="px-16 py-6 border-2 border-white/10 hover:border-red-500/40 hover:bg-red-500/10 text-slate-500 hover:text-red-400 rounded-full font-black uppercase tracking-widest transition-all">Suspend Sync</button>
                <div className="flex items-center gap-5 text-[12px] uppercase tracking-[0.5em] text-indigo-400 font-black animate-pulse">
                  Synaptic Stream Active
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="w-full lg:w-[520px] glass rounded-[5rem] flex flex-col overflow-hidden bg-black/50">
          <div className="p-12 border-b border-white/5 bg-white/5 flex justify-between items-center backdrop-blur-5xl">
            <div className="flex flex-col">
                <h2 className="heading text-xs font-black text-slate-300 uppercase tracking-[0.4em]">Synaptic Transcripts</h2>
            </div>
            <button onClick={startNewConversation} className="p-4 bg-white/5 hover:bg-indigo-600/30 text-indigo-400 rounded-3xl transition-all border border-transparent hover:border-indigo-500/30">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-12 space-y-12 custom-scrollbar bg-black/30">
            {history.map((entry, idx) => (
              <div key={idx} className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in group`}>
                <span className={`text-[11px] mb-3 font-black uppercase tracking-[0.2em] mx-6 flex items-center gap-3 ${entry.role === 'user' ? 'text-slate-600' : 'text-indigo-500'}`}>
                  {entry.role === 'user' ? 'Inbound Signal' : 'MindV Logic'}
                </span>
                {entry.text && (
                  <div className={`p-8 rounded-[3rem] text-sm leading-[1.8] shadow-3xl ${entry.role === 'user' ? 'bg-zinc-900 text-slate-300 rounded-tr-none border border-white/5' : 'bg-indigo-600/10 text-indigo-50 rounded-tl-none border border-indigo-500/25 backdrop-blur-2xl'}`}>
                    {entry.text}
                  </div>
                )}
                {entry.image && (
                  <div className="mt-4 max-w-full rounded-[2rem] overflow-hidden border border-white/10 shadow-4xl group/img relative">
                    <img src={entry.image} alt="Visual Projection" className="w-full h-auto object-cover" />
                  </div>
                )}
              </div>
            ))}
            <div ref={historyEndRef} />
          </div>
        </section>
      </main>

      {/* Global Notifications with Key Selection */}
      {error && (
        <div className="fixed top-36 inset-x-0 flex justify-center px-8 z-[200] pointer-events-none">
          <div className="bg-red-950/95 border border-red-500/50 backdrop-blur-5xl p-10 rounded-[4rem] flex flex-col items-center gap-6 max-w-3xl w-full shadow-4xl animate-slide-down pointer-events-auto">
             <div className="flex items-center gap-10">
               <div className="bg-red-500/25 p-6 rounded-3xl flex-shrink-0">
                 <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
               </div>
               <div className="flex-1">
                 <h3 className="text-red-100 font-black text-2xl mb-3 uppercase tracking-tight">{error.title}</h3>
                 <p className="text-red-300/90 text-sm leading-relaxed font-bold">{error.message}</p>
                 <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="text-xs text-red-400/60 underline mt-2 block italic">View Synapse Billing Documentation</a>
               </div>
             </div>
             <div className="flex gap-10 mt-4 w-full justify-end">
               <button onClick={() => setError(null)} className="text-[12px] font-black uppercase tracking-[0.4em] text-red-400 hover:text-white transition-all">Dismiss</button>
               {error.isPermission ? (
                 <button onClick={handleKeySelection} className="text-[12px] font-black uppercase tracking-[0.4em] text-white bg-indigo-600 px-8 py-3 rounded-2xl shadow-xl hover:bg-indigo-500 transition-all">Link Professional Synapse</button>
               ) : (
                 <button onClick={() => window.location.reload()} className="text-[12px] font-black uppercase tracking-[0.4em] text-white bg-red-600 px-8 py-3 rounded-2xl shadow-xl">Restart System</button>
               )}
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;