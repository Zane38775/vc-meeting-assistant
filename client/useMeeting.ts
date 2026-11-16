import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveCommand, LiveEvent, MeetingSnapshot, Segment } from '../shared/types';
import { captureAudio } from './audio';
import { api } from './api';

type Capture = Awaited<ReturnType<typeof captureAudio>>;
export function useMeeting(id: string | null, report: (error: string) => void) {
  const [snapshot, setSnapshot] = useState<MeetingSnapshot | null>(null);
  const [partial, setPartial] = useState<Segment | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [status, setStatus] = useState<{ stage: string; message: string; latencyMs?: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [gap, setGap] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const capture = useRef<Capture | null>(null);
  const captureStopping = useRef<Promise<void> | null>(null);
  const captureStartSeq = useRef<number | null>(null);
  const localControl = useRef(false);
  const latest = useRef<MeetingSnapshot | null>(null);
  const generation = useRef(0);
  const gapPending = useRef(false);
  const audioSeq = useRef(0);
  const audioPending = useRef(new Map<number, number>());
  const audioAllowed = useRef(false);
  const reportRef = useRef(report);
  reportRef.current = report;

  const stopCapture = useCallback(async (flush = false) => {
    if (!flush) {
      audioAllowed.current = false;
      captureStartSeq.current = null;
    }
    const current = capture.current;
    capture.current = null;
    setCapturing(false);
    setLevels({ mic: 0, system: 0 });
    audioPending.current.clear();
    if (current) {
      captureStopping.current = current.stop().finally(() => {
        captureStopping.current = null;
        audioAllowed.current = false;
      });
    }
    const stopping = captureStopping.current;
    if (flush) await stopping;
    else await stopping?.catch(() => undefined);
  }, []);
  const send = useCallback((command: LiveCommand) => {
    if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('实时连接尚未就绪，请等待连接恢复。');
    socket.current.send(JSON.stringify(command));
  }, []);
  const refresh = useCallback(async () => {
    if (!id) return;
    const data = await api<MeetingSnapshot>(`/meetings/${id}`);
    if (latest.current?.meeting.id === id && latest.current.seq > data.seq) return;
    latest.current = data;
    setSnapshot(data);
  }, [id]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    latest.current = null;
    setSnapshot(null); setPartial(null); setStatus(null); setGap(false);
    audioSeq.current = 0; gapPending.current = false;
    if (!id) return;
    let disposed = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const accept = (data: MeetingSnapshot) => {
      if (data.meeting.id !== id || (latest.current && data.seq < latest.current.seq)) return;
      latest.current = data; setSnapshot(data);
      setPartial(previous => previous && !data.segments.some(s => s.id === previous.id || s.endMs >= previous.endMs && s.speaker === previous.speaker) ? previous : null);
      if (data.meeting.status === 'ended' || (data.meeting.status === 'paused' && captureStartSeq.current === null)) {
        void stopCapture();
      }
    };
    void api<MeetingSnapshot>(`/meetings/${id}`).then(data => { if (!disposed) accept(data); }).catch(error => { if (!disposed) reportRef.current(error.message); });
    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      const url = new URL(`/api/meetings/${id}/live`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url); socket.current = ws;
      let openedAt = 0;
      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        openedAt = Date.now(); setConnection('connected');
        if (gapPending.current) {
          ws.send(JSON.stringify({ type: 'gap', message: '实时连接中断，已停止音频采集；中断期间音频未转写。' }));
          gapPending.current = false;
        }
        void api<MeetingSnapshot>(`/meetings/${id}`).then(data => { if (!disposed) accept(data); }).catch(error => reportRef.current(error.message));
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
      };
      ws.onmessage = event => {
        if (disposed) return;
        let message: LiveEvent;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'snapshot') {
          const snapshot = message.data;
          if (captureStartSeq.current !== null && snapshot.meeting.id === id
            && snapshot.meeting.status === 'live' && snapshot.seq > captureStartSeq.current) {
            captureStartSeq.current = null;
          }
          accept(snapshot);
        }
        else if (message.type === 'transcript.partial') setPartial(message.data);
        else if (message.type === 'status') setStatus(message);
        else if (message.type === 'audio.ack') {
          if (audioPending.current.delete(message.seq)) captureStartSeq.current = null;
        }
        else if (message.type === 'error') {
          reportRef.current(message.message);
          if (capture.current && message.command === 'audio') {
            setGap(true); void stopCapture();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pause' }));
            } else gapPending.current = true;
          } else if (message.command === 'start' || message.command === 'resume') {
            void stopCapture();
          }
        }
      };
      ws.onerror = () => { /* onclose performs bounded retry and reports visible connection state. */ };
      ws.onclose = event => {
        if (heartbeat) clearInterval(heartbeat);
        if (disposed) return;
        if (capture.current) { gapPending.current = true; setGap(true); reportRef.current('连接中断，录音已停止。恢复连接后请重新开启采集；中断的音频不会补写。'); }
        void stopCapture(); setConnection('disconnected');
        if (event.code === 4003 || event.code === 1008) {
          latest.current = null; setSnapshot(null);
          reportRef.current('本场会议的访问权限已撤销或登录已失效，请返回项目检查权限。');
          return;
        }
        if (openedAt && Date.now() - openedAt > 10000) attempts = 0;
        // Re-fetch on close to discard access-revoked snapshots, including private notes.
        void api<MeetingSnapshot>(`/meetings/${id}`).then(data => { if (!disposed) accept(data); }).catch(() => { if (!disposed) { latest.current = null; setSnapshot(null); } });
        if (attempts < 6) retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (generation.current === currentGeneration) generation.current++;
      if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat);
      const ws = socket.current; socket.current = null; ws?.close();
      void stopCapture();
    };
  }, [id, retryEpoch, stopCapture]);

  const begin = useCallback(async () => {
    if (localControl.current || captureStopping.current) throw new Error('音频采集操作仍在进行，请稍后再试。');
    const data = latest.current;
    if (!data || capture.current) return;
    if (data.meeting.demo) { send({ type: data.meeting.status === 'paused' ? 'resume' : 'demo.start' }); return; }
    if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('请先等待实时连接就绪。');
    localControl.current = true;
    setCaptureBusy(true);
    const token = generation.current;
    let failed = false;
    let accepting = false;
    const fail = (message: string) => {
      if (token !== generation.current || failed) return;
      failed = true; setGap(true); reportRef.current(message);
      void stopCapture();
      try { send({ type: 'pause' }); send({ type: 'gap', message }); } catch { gapPending.current = true; }
    };
    try {
      const recorder = await captureAudio({
        mode: data.meeting.mode,
        onChunk: chunk => {
          const ws = socket.current;
          if (failed || !accepting || !audioAllowed.current || token !== generation.current) return;
          const oldest = audioPending.current.values().next().value as number | undefined;
          if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024 || audioPending.current.size >= 40 || oldest !== undefined && Date.now() - oldest > 10000) {
            throw new Error('音频传输未及时确认。这段音频可能不完整，请检查网络后继续。');
          }
          const seq = ++audioSeq.current;
          audioPending.current.set(seq, Date.now());
          ws.send(JSON.stringify({ type: 'audio', seq, capturedAt: chunk.capturedAt, pcm: chunk.pcm }));
        },
        onLevels: value => { if (token === generation.current) setLevels(value); },
        onError: error => fail(typeof error === 'string' ? error : error instanceof Error ? error.message : '音频采集中断，请重新选择音频来源。'),
      });
      if (token !== generation.current || failed) { await recorder.stop().catch(() => undefined); return; }
      capture.current = recorder;
      // Other edits can publish a paused snapshot before this request reaches the service.
      captureStartSeq.current = latest.current?.seq ?? data.seq;
      send({ type: data.meeting.status === 'ready' ? 'start' : 'resume' });
      accepting = true;
      audioAllowed.current = true;
      setCapturing(true); setGap(false);
    } catch (error) { await stopCapture(); throw error; }
    finally { localControl.current = false; setCaptureBusy(false); }
  }, [send, stopCapture]);

  const control = useCallback(async (type: 'pause' | 'stop') => {
    if (localControl.current) throw new Error('正在完成最后一段音频或选择音频来源，请稍后再试。');
    localControl.current = true;
    try {
      try {
        await stopCapture(true);
      } catch (error) {
        setGap(true);
        const detail = error instanceof Error ? error.message : String(error);
        send({ type: 'gap', message: `最后一段音频未能确认，请核对转写结尾。${detail}` });
      }
      send({ type });
      setPartial(null);
    } finally {
      localControl.current = false;
    }
  }, [send, stopCapture]);

  return { snapshot, partial, connection, status, capturing, captureBusy, levels, gap, begin, control, send, refresh, reconnect: () => setRetryEpoch(value => value + 1) };
}
