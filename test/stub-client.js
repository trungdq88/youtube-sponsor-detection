// A stand-in for TypeSafeClient that answers the way Jev would on an obvious
// case, and records every request so the tests can check what we send.
//
// It spots three kinds of line by keyword: where the sponsor is named, where
// a lead-in story begins, and where the creator hands back to the video.

export const SPONSOR_MARKERS = ['sponsored by', 'brought to you by', 'thanks to boot.dev', 'boot.dev is'];
const LEAD_IN_MARKERS = ['a couple months back', 'quick story', 'making today\'s video possible', 'quick pause because'];
const END_MARKERS = ['now let us get back', 'now back to', 'thank you kestrel', 'scan the qr code'];

export function createStubClient() {
  const requests = [];

  return {
    requests,
    async systemOne(request) {
      requests.push(request);
      const state = request.state;
      const text = String(state.video_transcript_excerpt ?? state);
      const rows = text.split('\n').map((row) => {
        const [id, ...rest] = row.split('| ');
        return { id, text: rest.join('| ').toLowerCase() };
      });
      const has = (r, markers) => markers.some((m) => r.text.includes(m));

      const anchorAt = rows.findIndex((r) => has(r, SPONSOR_MARKERS));
      const anchorRow = anchorAt >= 0 ? rows[anchorAt] : undefined;
      const endRow = anchorRow ? rows.slice(anchorAt).find((r) => has(r, END_MARKERS)) : undefined;
      const answers = {};

      for (const [name, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[name] = { type: 'noul', noul: anchorRow ? 0.94 : 0.04 };
          continue;
        }
        const labels = Object.keys(question.criteria);
        let target;
        if (name === 'start_line') {
          // Reading backwards from the naming line for a lead-in.
          const namedAt = rows.findIndex((r) => r.id === state.sponsor_named_at);
          const leadIn = rows.slice(Math.max(0, namedAt - 40), namedAt + 1).find((r) => has(r, LEAD_IN_MARKERS));
          target = (leadIn ?? rows[namedAt])?.id;
        } else if (name === 'end_line') {
          target = endRow?.id;
        } else {
          target = anchorRow?.id;
        }
        const picked = target && labels.includes(target) ? target : labels[labels.length - 1];
        answers[name] = { type: 'choice', choice: picked, confidence: 0.88, probabilities: distribute(labels, picked, 0.88) };
      }

      return { model: 'jev-1.13.0', answers, usage: { input_tokens: text.length / 4, output_tokens: 12 } };
    }
  };
}

function distribute(labels, picked, mass) {
  const rest = (1 - mass) / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, l === picked ? mass : rest]));
}
