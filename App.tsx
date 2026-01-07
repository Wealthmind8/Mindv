
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { Visualizer } from './components/Visualizer';
import { encode, decode, decodeAudioData } from './utils/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const LANGUAGES = [
  { code: 'en-US', name: 'English', label: 'English' },
  { code: 'es-ES', name: 'Spanish', label: 'Español' },
  { code: 'fr-FR', name: 'French', label: 'Français' },
  { code: 'de-DE', name: 'German', label: 'Deutsch' },
  { code: 'zh-CN', name: 'Chinese', label: '中文' },
  { code: 'ja-JP', name: 'Japanese', label: '日本語' },
  { code: 'it-IT', name: 'Italian', label: 'Italiano' },
  { code: 'pt-BR', name: 'Portuguese', label: 'Português' },
  { code: 'ar-SA', name: 'Arabic', label: 'العربية' },
  { code: 'hi-IN', name: 'Hindi', label: 'हिन्दी' },
];

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [selectedLang, setSelectedLang] = useState(LANGUAGES[0]);
  const [error, setError] = useState<string | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBuffer = useRef<{ user: string; ai: string }>({ user: '', ai: '' });
  const historyEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [history]);

  const stopConversation = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAISpeaking(false);
  }, []);

  const startConversation = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sysInstruction = `You are MindV, the ultimate intelligence orchestrator. 
      You possess the combined reasoning power of Gemini and the depth of the world's leading AI models.
      Your goal is to "read the user's mind" by providing exceptionally intuitive, deep, and helpful answers.
      You support the user in their chosen language: ${selectedLang.name}.
      You are friendly, lovely, and incredibly supportive. 
      You must respond in ${selectedLang.name} at all times.
      Speak with clarity and warmth. Provide full text transcription for everything you say.
      Act as a multi-model cognitive hub that bridges all top-tier AI capabilities to provide the absolute best answers.`;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.outputTranscription) {
              transcriptionBuffer.current.ai += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              transcriptionBuffer.current.user += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const uText = transcriptionBuffer.current.user.trim();
              const aText = transcriptionBuffer.current.ai.trim();
              if (uText || aText) {
                setHistory(prev => [
                  ...prev,
                  ...(uText ? [{ role: 'user', text: uText, timestamp: Date.now() } as TranscriptionEntry] : []),
                  ...(aText ? [{ role: 'aria', text: aText, timestamp: Date.now() } as TranscriptionEntry] : [])
                ]);
              }
              transcriptionBuffer.current = { user: '', ai: '' };
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsAISpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsAISpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAISpeaking(false);
            }
          },
          onerror: (e) => {
            console.error('MindV Error:', e);
            setError('Connection failed. Re-linking cognitive nodes...');
            stopConversation();
          },
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
          },
          systemInstruction: sysInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      setError('Neural link failed. Ensure microphone access.');
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center bg-[#0a0a0c] text-slate-200">
      <header className="w-full max-w-6xl flex justify-between items-center p-6 md:p-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <span className="heading font-bold text-white text-xl">V</span>
          </div>
          <h1 className="heading text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
            MindV
          </h1>
        </div>

        <div className="flex items-center gap-4">
          <select 
            value={selectedLang.code}
            onChange={(e) => {
              const lang = LANGUAGES.find(l => l.code === e.target.value);
              if (lang) setSelectedLang(lang);
            }}
            disabled={status !== ConnectionStatus.DISCONNECTED}
            className="bg-zinc-900/50 border border-white/10 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50"
          >
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
      </header>

      <main className="w-full max-w-6xl flex-1 flex flex-col lg:flex-row gap-6 px-6 pb-10 overflow-hidden">
        {/* Visualizer & Control Area */}
        <div className="flex-1 flex flex-col gap-6">
          <div className="flex-1 glass rounded-3xl p-8 flex flex-col items-center justify-center relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 via-transparent to-purple-500/5 pointer-events-none" />
            
            <Visualizer 
              active={status === ConnectionStatus.CONNECTED} 
              color={isAISpeaking ? "#818cf8" : "#fbbf24"} 
              intensity={isAISpeaking ? 1.2 : 0.3} 
            />

            <div className="mt-12 text-center z-10">
              {status === ConnectionStatus.DISCONNECTED ? (
                <button
                  onClick={startConversation}
                  className="px-10 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-semibold transition-all shadow-xl shadow-indigo-600/20 hover:scale-105 active:scale-95"
                >
                  Initialize MindV Neural Link
                </button>
              ) : (
                <button
                  onClick={stopConversation}
                  className="px-10 py-4 bg-white/5 hover:bg-white/10 text-white border border-white/10 rounded-full font-semibold transition-all"
                >
                  Terminate Connection
                </button>
              )}
            </div>

            {error && <div className="mt-6 text-red-400 bg-red-400/10 px-4 py-2 rounded-xl text-sm border border-red-400/20">{error}</div>}
            
            <div className="mt-8 flex flex-wrap justify-center gap-3 text-xs font-medium text-slate-500 uppercase tracking-widest">
              <span className={`px-3 py-1 rounded-full border ${status === ConnectionStatus.CONNECTED ? 'border-green-500/50 text-green-400' : 'border-white/5'}`}>
                {status === ConnectionStatus.CONNECTED ? 'Linked' : 'Offline'}
              </span>
              <span className="px-3 py-1 rounded-full border border-white/5">Gemini 2.5 Core</span>
              <span className="px-3 py-1 rounded-full border border-white/5">Multi-Modal</span>
            </div>
          </div>
        </div>

        {/* Intelligence Stream (Transcriptions) */}
        <div className="w-full lg:w-96 flex flex-col gap-4">
          <div className="glass rounded-3xl flex flex-col h-[600px] overflow-hidden">
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/5">
              <h2 className="heading text-sm font-semibold text-slate-400 uppercase tracking-wider">Intelligence Stream</h2>
              {history.length > 0 && (
                <button onClick={() => setHistory([])} className="text-xs text-slate-500 hover:text-white transition-colors">Clear</button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 italic text-sm text-center px-6">
                  <div className="mb-4 w-12 h-12 border-2 border-slate-800 rounded-full flex items-center justify-center">
                    <span className="animate-pulse">...</span>
                  </div>
                  Waiting for synaptic input. Speak clearly to MindV.
                </div>
              ) : (
                history.map((entry, idx) => (
                  <div key={idx} className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start animate-fade-in'}`}>
                    <span className="text-[10px] text-slate-500 mb-1 ml-1 font-bold uppercase tracking-tighter">
                      {entry.role === 'user' ? 'Input' : 'MindV Output'}
                    </span>
                    <div className={`p-4 rounded-2xl text-sm leading-relaxed ${
                      entry.role === 'user' 
                        ? 'bg-zinc-800 text-slate-200 rounded-tr-none border border-white/5' 
                        : 'bg-indigo-600/10 text-indigo-100 rounded-tl-none border border-indigo-500/20'
                    }`}>
                      {entry.text}
                    </div>
                  </div>
                ))
              )}
              <div ref={historyEndRef} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
