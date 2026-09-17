// A stand-in for TypeSafeClient that answers the way Jev would on an obvious
// case, and records every request so the tests can check what we send.

export const SPONSOR_MARKERS = ['making today\'s video possible', 'sponsored by', 'brought to you by'];
const END_MARKERS = ['now let us get back', 'now back to', 'thank you kestrel'];

export function createStubClient() {
  const requests = [];

  return {
    requests,
    async systemOne(request) {
      requests.push(request);
      const text = String(request.state.video_transcript_excerpt ?? request.state);
      const rows = text.split('\n').map((row) => {
        const [id, ...rest] = row.split('| ');
        return { id, text: rest.join('| ').toLowerCase() };
      });

      const startRow = rows.find((r) => SPONSOR_MARKERS.some((m) => r.text.includes(m)));
      const endRow = [...rows].reverse().find((r) => END_MARKERS.some((m) => r.text.includes(m)));
      const answers = {};

      for (const [name, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[name] = { type: 'noul', noul: startRow ? 0.94 : 0.04 };
        } else if (question.type === 'choice') {
          const labels = Object.keys(question.criteria);
          const wantsEnd = /LAST line/.test(String(question.instructions));
          const target = wantsEnd ? endRow?.id : startRow?.id;
          const picked = target && labels.includes(target) ? target : labels[labels.length - 1];
          answers[name] = {
            type: 'choice',
            choice: picked,
            confidence: 0.88,
            probabilities: distribute(labels, picked, 0.88)
          };
        }
      }

      return { model: 'jev-1.13.0', answers, usage: { input_tokens: text.length / 4, output_tokens: 12 } };
    }
  };
}

function distribute(labels, picked, mass) {
  const rest = (1 - mass) / Math.max(1, labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, l === picked ? mass : rest]));
}
