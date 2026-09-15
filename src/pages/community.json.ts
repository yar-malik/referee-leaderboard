// The list of fan poll questions the community API will accept, generated at build time.
import { allFanPolls, allPosts, clubs } from '../lib/data';

export function GET() {
  const polls = allFanPolls().map((p) => ({
    id: p.id,
    options: p.options,
    kind: p.kind,
    hubs: p.hubs,
    harmed: p.grievance?.harmed ?? null,
    benefited: p.grievance?.benefited ?? null,
    grievance: p.grievance?.option ?? null,
  }));
  const posts = allPosts().map((p) => ({ id: p.id, thread: p.thread }));
  return new Response(JSON.stringify({ clubs: clubs.map((c) => c.id), polls, posts }), { headers: { 'content-type': 'application/json' } });
}
