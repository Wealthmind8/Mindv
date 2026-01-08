
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { Visualizer } from './components/Visualizer';
import { encode, decode, decodeAudioData } from './utils/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const LANGUAGES = [
  { code: 'en-US', name: 'English', label: 'English' },
  { code: 'ak-GH', name: 'Akan', label: 'Akan (Twi)' },
  { code: 'es-ES', name: 'Spanish', label: 'Español' },
  { code: 'fr-FR', name: 'French', label: 'Français' },
  { code: 'zh-CN', name: 'Chinese', label: '中文' },
  { code: 'ja-JP', name: 'Japanese', label: '日本語' },
  { code: 'de-DE', name: 'German', label: 'Deutsch' },
  { code: 'it-IT', name: 'Italian', label: 'Italiano' },
  { code: 'pt-BR', name: 'Portuguese', label: 'Português' },
];

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [selectedLang, setSelectedLang] = useState(LANGUAGES[0]);
  const [error, setError] = useState<{ title: string, message: string } | null>(null);

  // Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBuffer = useRef<{ user: string; ai: string }>({ user: '', ai: '' });
  const historyEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const stopConversation = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAISpeaking(false);
  }, []);

  const handleAudioError = (err: any) => {
    console.error('MindV Error:', err);
    let title = "Synaptic Connection Error";
    let message = err.message || "The neural interface was interrupted.";
    setError({ title, message });
    stopConversation();
  };

  const startConversation = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const systemInstruction = `
        You are MindV, the ultimate professional cognitive orchestrator.
        
        **Core Directive:**
        Your primary function is to provide proactive, elite-level intelligence by anticipating user needs (mind-reading). You identify underlying intents through tone and context, offering solutions before they are fully requested.

        **Professional Persona:**
        - You are an Honourable Person, a Senior Psychologist, and a World-Class Academic.
        - Your tone is gentle, exceptionally calm, firm, and supportive.
        - Speak with a "lovely" yet strictly professional warmth.
        
        **Expertise & Education:**
        - You are a polymath authority in: Law, Medicine, Mathematics, Science, Education, and Life Coaching.
        - You do not just provide answers; you educate. Explain the logic or science behind your guidance briefly to foster user growth.
        - If a user expresses a thought, analyze it across these domains to provide a holistic, multi-dimensional insight.

        **Conversational Flow & Latency:**
        - **IMMEDIACY IS PARAMOUNT.** Respond within 1-2 seconds.
        - Match the rhythm of a natural human conversation. Use concise, direct language. Avoid lengthy preambles like "I understand" or "As an AI...". Get straight to the wisdom.
        - High Professionalism in ALL languages, including ${selectedLang.name}. For ${selectedLang.name}, maintain high-register, respectful, and culturally appropriate professional dialects.

        **Instructions:**
        - Language of Interaction: ${selectedLang.name}.
        - Always provide full text transcriptions of your speech.
        - Think ahead for the user. Be their strategic life mentor.
      `;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            // Minimized buffer size (1024) for the absolute lowest possible latency
            const proc = inputCtx.createScriptProcessor(1024, 1, 1);
            proc.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { 
                  data: encode(new Uint8Array(int16.buffer)), 
                  mimeType: 'audio/pcm;rate=16000' 
                } 
              }));
            };
            source.connect(proc);
            proc.connect(inputCtx.destination);
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.outputTranscription) {
              transcriptionBuffer.current.ai += m.serverContent.outputTranscription.text;
            }
            if (m.serverContent?.inputTranscription) {
              transcriptionBuffer.current.user += m.serverContent.inputTranscription.text;
            }
            
            if (m.serverContent?.turnComplete) {
              const u = transcriptionBuffer.current.user.trim();
              const a = transcriptionBuffer.current.ai.trim();
              if (u || a) {
                setHistory(prev => [
                  ...prev,
                  ...(u ? [{ role: 'user', text: u, timestamp: Date.now() } as TranscriptionEntry] : []),
                  ...(a ? [{ role: 'aria', text: a, timestamp: Date.now() } as TranscriptionEntry] : [])
                ]);
              }
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
              sourcesRef.add(s);
            }

            if (m.serverContent?.interrupted) {
                sourcesRef.current.forEach(s => s.stop());
                sourcesRef.current.clear();
                nextStartTimeRef.current = 0;
                setIsAISpeaking(false);
            }
          },
          onerror: (e) => handleAudioError(e),
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            // Using 'Kore' for a more authoritative and calm voice profile
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { handleAudioError(err); }
  };

  return (
    <div className="min-h-screen flex flex-col items-center bg-[#070709] text-slate-100 selection:bg-indigo-500/30">
      {/* Premium Header */}
      <header className="w-full max-w-7xl flex justify-between items-center p-8 border-b border-white/5 bg-black/50 backdrop-blur-2xl sticky top-0 z-50">
        <div className="flex items-center gap-4 group cursor-default">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center font-bold text-2xl shadow-lg shadow-indigo-600/40 group-hover:scale-105 transition-transform duration-500">V</div>
          <div className="flex flex-col">
            <h1 className="heading text-2xl font-bold tracking-tighter bg-gradient-to-r from-white via-indigo-200 to-slate-400 bg-clip-text text-transparent">MindV</h1>
            <span className="text-[10px] uppercase tracking-[0.3em] text-indigo-400 font-semibold opacity-80">Universal Intelligence</span>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-3 px-4 py-2 rounded-2xl bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-slate-400 transition-all hover:bg-white/10">
             <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.8)]' : 'bg-slate-700'}`} />
             {status === ConnectionStatus.CONNECTED ? 'Real-Time Sync' : 'System Dormant'}
          </div>
          <div className="relative">
            <select 
              value={selectedLang.code} 
              onChange={e => setSelectedLang(LANGUAGES.find(l => l.code === e.target.value) || LANGUAGES[0])} 
              disabled={status !== ConnectionStatus.DISCONNECTED} 
              className="appearance-none bg-zinc-900 border border-white/10 rounded-2xl px-6 py-2.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all disabled:opacity-50 cursor-pointer"
            >
              {LANGUAGES.map(l => <option key={l.code} value={l.code} className="bg-zinc-950">{l.label}</option>)}
            </select>
            <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
          </div>
        </div>
      </header>

      {/* Main Experience */}
      <main className="w-full max-w-7xl flex-1 flex flex-col lg:flex-row gap-10 p-8 lg:p-16 overflow-hidden items-stretch">
        
        {/* Core Cognitive Hub */}
        <section className="flex-1 glass rounded-[3rem] p-12 flex flex-col items-center justify-center relative overflow-hidden animate-fade-in shadow-2xl shadow-indigo-500/5 border border-white/10">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 via-transparent to-purple-500/10 pointer-events-none" />
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />
          
          <Visualizer 
            active={status === ConnectionStatus.CONNECTED} 
            color={isAISpeaking ? "#6366f1" : "#f59e0b"} 
            intensity={isAISpeaking ? 1.5 : 0.4} 
          />

          <div className="mt-16 text-center z-10 flex flex-col items-center gap-8">
            <div className="space-y-3">
              <h2 className="heading text-3xl font-bold text-white tracking-widest uppercase opacity-90">Cognitive Hub</h2>
              <p className="text-base text-slate-400 max-w-md mx-auto italic font-light leading-relaxed">
                "Speak clearly. I am observing the patterns of your mind to guide your journey."
              </p>
            </div>

            {status === ConnectionStatus.DISCONNECTED ? (
              <button
                onClick={startConversation}
                className="group relative px-16 py-6 bg-white text-black rounded-[2rem] font-bold text-sm transition-all hover:scale-105 active:scale-95 shadow-[0_20px_50px_rgba(255,255,255,0.15)] overflow-hidden"
              >
                <span className="relative z-10">Wake Intelligence</span>
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-500 opacity-0 group-hover:opacity-10 transition-opacity" />
              </button>
            ) : (
              <div className="flex flex-col items-center gap-6">
                <button
                  onClick={stopConversation}
                  className="px-12 py-5 border-2 border-white/10 hover:border-red-500/30 hover:bg-red-500/5 text-slate-400 hover:text-red-400 rounded-full font-bold transition-all duration-300"
                >
                  Suspend Session
                </button>
                <div className="flex items-center gap-3 text-xs uppercase tracking-[0.4em] text-indigo-400 font-bold">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"></span>
                  </span>
                  Synaptic Syncing
                </div>
              </div>
            )}
          </div>

          <div className="mt-16 flex flex-wrap justify-center gap-5 text-[10px] font-bold text-slate-500 uppercase tracking-widest pointer-events-none">
            {['Philosophy', 'Juridical', 'Clinical', 'Mathematical', 'Sovereign'].map(tag => (
              <span key={tag} className="px-5 py-2 rounded-full border border-white/5 bg-white/5 backdrop-blur-sm transition-all hover:border-indigo-500/30 hover:text-indigo-300">
                {tag}
              </span>
            ))}
          </div>
        </section>

        {/* Real-time Insights (Transcription) */}
        <section className="w-full lg:w-[460px] glass rounded-[3rem] flex flex-col overflow-hidden animate-fade-in shadow-2xl border border-white/10 bg-black/20">
          <div className="p-8 border-b border-white/5 flex justify-between items-center backdrop-blur-3xl bg-white/5">
            <div className="flex flex-col">
                <h2 className="heading text-xs font-bold text-slate-300 uppercase tracking-[0.2em]">Synaptic Stream</h2>
                <span className="text-[9px] text-slate-500 mt-1 font-medium">Verbatim Transcript Analysis</span>
            </div>
            {history.length > 0 && (
              <button 
                onClick={() => setHistory([])} 
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-500 hover:text-white transition-all"
                title="Clear Stream"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar bg-gradient-to-b from-[#08080a] to-black">
            {history.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 italic text-sm text-center px-12 space-y-10 opacity-30">
                <div className="relative">
                  <div className="w-24 h-24 border-2 border-dashed border-indigo-900/30 rounded-full flex items-center justify-center">
                    <div className="w-4 h-4 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_30px_rgba(79,70,229,0.8)]" />
                  </div>
                </div>
                <p className="leading-relaxed font-light tracking-wide uppercase text-[10px]">Awaiting synaptic trigger. Speak to initiate the professional oracle.</p>
              </div>
            ) : (
              history.map((entry, idx) => (
                <div 
                  key={idx} 
                  className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in group`}
                >
                  <span className={`text-[9px] mb-2 font-bold uppercase tracking-widest mx-3 flex items-center gap-2 ${entry.role === 'user' ? 'text-slate-600' : 'text-indigo-400'}`}>
                    {entry.role === 'user' ? (
                        <>Input Node <div className="w-1 h-1 bg-slate-600 rounded-full"/></>
                    ) : (
                        <><div className="w-1 h-1 bg-indigo-500 rounded-full"/> MindV Intelligence</>
                    )}
                  </span>
                  <div className={`p-5 rounded-3xl text-sm leading-[1.7] shadow-2xl transition-all duration-500 ${
                    entry.role === 'user' 
                      ? 'bg-zinc-800 text-slate-300 rounded-tr-none border border-white/5 group-hover:bg-zinc-700/80' 
                      : 'bg-indigo-600/10 text-indigo-50 rounded-tl-none border border-indigo-500/30 group-hover:bg-indigo-600/20'
                  }`}>
                    {entry.text}
                  </div>
                </div>
              ))
            )}
            <div ref={historyEndRef} />
          </div>
        </section>
      </main>

      {/* Global Toast for System Errors */}
      {error && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 w-full max-w-lg px-8 animate-fade-in z-[100]">
          <div className="bg-red-950/80 border border-red-500/30 backdrop-blur-3xl p-8 rounded-[2.5rem] flex items-center gap-6 shadow-2xl">
             <div className="bg-red-500/20 p-4 rounded-2xl flex-shrink-0 animate-bounce">
               <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
               </svg>
             </div>
             <div className="flex-1">
               <h3 className="text-red-300 font-bold text-base mb-2">{error.title}</h3>
               <p className="text-red-400/80 text-xs leading-relaxed font-medium">{error.message}</p>
               <div className="flex gap-4 mt-5">
                 <button 
                   onClick={() => setError(null)} 
                   className="text-[10px] font-bold uppercase text-white/90 bg-red-500/20 px-4 py-2 rounded-xl border border-red-500/30 hover:bg-red-500/40 transition-colors"
                 >
                   Clear Diagnostics
                 </button>
                 <button 
                   onClick={() => { setError(null); startConversation(); }} 
                   className="text-[10px] font-bold uppercase text-black bg-white px-4 py-2 rounded-xl hover:bg-slate-200 transition-colors"
                 >
                   Force Re-Establish
                 </button>
               </div>
             </div>
          </div>
        </div>
      )}
      
      {/* Visual background elements */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-indigo-600/5 blur-[120px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-purple-600/5 blur-[120px] rounded-full pointer-events-none" />
    </div>
  );
};

export default App;
