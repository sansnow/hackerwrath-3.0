import { useState, useEffect } from 'react';
import type { RAGHealthResponse } from '../hooks/useLiveDetection';
import { fetchRagHealth } from '../spell/rag';

interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'DISABLED' | 'DELIVERY_FAILED' | 'UNAUTHORIZED';
  alert_threshold?: string;
  total_alerts_sent?: number;
}

interface HealthStatus {
  status: string;
  version: string;
  sarvam_configured: boolean;
  modules?: {
    telegram_alerts?: {
      working: boolean;
      configured: boolean;
      enabled: boolean;
      threshold: string;
    };
  };
}

export default function StatusBar() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [ragHealth, setRagHealth] = useState<RAGHealthResponse | null>(null);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    async function checkHealth() {
      fetchRagHealth().then(setRagHealth);
      try {
        const [healthRes, tgRes] = await Promise.allSettled([
          fetch('/health', { signal: AbortSignal.timeout(3000) }),
          fetch('/telegram/status', { signal: AbortSignal.timeout(3000) }),
        ]);

        if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
          const data = await healthRes.value.json();
          setHealth(data);
          setIsOnline(true);
        } else {
          setIsOnline(false);
        }

        if (tgRes.status === 'fulfilled' && tgRes.value.ok) {
          const tgData = await tgRes.value.json();
          setTelegram(tgData);
        }
      } catch {
        setIsOnline(false);
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const telegramLabel = () => {
    if (!telegram || !telegram.configured) return { dot: 'bg-off', text: 'Telegram alerts: not set up' };
    if (telegram.status === 'CONNECTED') return { dot: 'bg-accent', text: `Telegram alerts: on (${telegram.alert_threshold || 'HIGH'})` };
    if (telegram.status === 'UNAUTHORIZED' || telegram.status === 'DELIVERY_FAILED') return { dot: 'bg-danger', text: 'Telegram alerts: failing' };
    return { dot: 'bg-warn', text: 'Telegram alerts: muted' };
  };
  const tg = telegramLabel();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between text-[12px] gap-x-5 gap-y-2 flex-wrap text-faint">
      <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
        <span className="flex items-center gap-1.5 font-semibold">
          <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-accent' : 'bg-danger'}`} />
          <span className={isOnline ? 'text-ink' : 'text-danger-text'}>{isOnline ? 'Detector connected' : 'Detector offline'}</span>
        </span>
        {ragHealth && (
          <span className="flex items-center gap-1.5 font-semibold">
            <span className={`w-2 h-2 rounded-full ${ragHealth.vector_index_loaded ? 'bg-accent' : 'bg-warn'}`} />
            {ragHealth.vector_index_loaded
              ? `Real-call library: ${ragHealth.indexed_documents_count.toLocaleString()} calls`
              : 'Real-call library: not loaded'}
          </span>
        )}
        {health && (
          <span className="flex items-center gap-1.5 font-semibold">
            <span className={`w-2 h-2 rounded-full ${health.sarvam_configured ? 'bg-accent' : 'bg-warn'}`} />
            {health.sarvam_configured ? 'Speech to text: Sarvam' : 'Speech to text: demo mode'}
          </span>
        )}
        <span className="flex items-center gap-1.5 font-semibold">
          <span className={`w-2 h-2 rounded-full ${tg.dot}`} />
          {tg.text}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden md:inline">A web page can’t hang up a phone call: hang up from your phone.</span>
        <span>v{health?.version || '1.0.0'}</span>
      </div>
    </div>
  );
}
