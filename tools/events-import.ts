import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateEvents, type HistoricalEvent } from '../src/forecast.js';
import { DocumentStore } from '../src/storage.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run events:import -- path/to/events.json');
const incoming = validateEvents(JSON.parse(await readFile(file, 'utf8')));
const store = new DocumentStore(join(process.cwd(), 'reports', 'state.sqlite'));
try {
  const saved = store.update<HistoricalEvent[]>('events', current => {
    const merged = new Map(validateEvents(current ?? []).map(event => [event.id, event]));
    for (const event of incoming) {
      const existing = merged.get(event.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error(`Conflicting event ID: ${event.id}`);
      merged.set(event.id, event);
    }
    return [...merged.values()];
  });
  console.log(JSON.stringify({ imported: incoming.length, total: saved.length, file }, null, 2));
} finally { store.close(); }