import { useRef, useEffect } from 'react';
import type { TranscriptSegment } from '../hooks/useLiveDetection';

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  isListening: boolean;
}

const SPEAKER: Record<string, string> = {
  text_input: 'Typed',
  caller: 'They said',
  user: 'You said',
};

export default function TranscriptPanel({ segments, isListening }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments]);

  return (
    <div className="sb-card p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <span className="sb-eyebrow">Transcript</span>
        {isListening && (
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-accent">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            Listening
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto flex flex-col gap-2.5 pr-1 min-h-[200px] max-h-[420px]">
        {segments.length === 0 ? (
          <p className="m-auto text-center text-[14px] text-faint py-10">
            {isListening ? 'Waiting for someone to speak…' : 'Words you check will show up here.'}
          </p>
        ) : (
          segments.map((seg, i) => (
            <div key={i} className="sb-soft rounded-[16px] px-4 py-3 sb-rise">
              <div className="flex items-center justify-between mb-1 text-[11px]">
                <span className="font-bold tracking-[0.12em] uppercase text-faint">{SPEAKER[seg.speaker] || seg.speaker}</span>
                <span className="text-faint">
                  {new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {Math.round(seg.confidence * 100)}% clear
                </span>
              </div>
              <p className="text-[15px] leading-[22px] text-ink">{seg.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
