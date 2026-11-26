// Technique notes, phase 1: no body tracking, only what the flights already tell (where and how high each ball was met, when after
// its bounce, how high over the net, how much spin, where the player was 1.2 s later, the serve toss). Every note compares the
// player's own shots with each other ("what works for you") or with what coaches agree is good practice, and comes with a fix and
// a drill. Nothing is sent anywhere and nothing is learned: fixed rules and plain counting. See claude/12 in the project docs.
import { getLang } from './i18n.js';

const MIN = 8; // shots per group before a comparison is shown
const inRate = a => a.length ? a.filter(q => q.result === 'in').length / a.length : 0;
const med = a => { a = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const sd = a => { a = a.filter(v => isFinite(v)); if (a.length < 2) return null; const m = a.reduce((p, v) => p + v, 0) / a.length; return Math.sqrt(a.reduce((p, v) => p + (v - m) ** 2, 0) / (a.length - 1)); };
// two shares: how sure is the difference (z of a two-proportion test)
const zOf = (a, b) => { const n1 = a.length, n2 = b.length; if (!n1 || !n2) return 0; const p1 = inRate(a), p2 = inRate(b), p = (p1 * n1 + p2 * n2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)); return se > 0 ? (p1 - p2) / se : 0; };
const pct = v => Math.round(100 * v) + '%';
const m1 = v => (Math.abs(v) < 2 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10).toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-GB') + ' m';
const sec = v => (Math.round(v * 100) / 100).toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-GB') + ' s';
// the best example of a group (in, fast, deep) and the worst (not in)
const bestOf = a => a.filter(q => q.result === 'in').sort((x, y) => (y.speed + 3 * y.land[1]) - (x.speed + 3 * x.land[1]))[0] || null;
const worstOf = a => a.filter(q => q.result !== 'in').sort((x, y) => x.speed - y.speed)[0] || null;

// The rule base: for each note, the finding (with the numbers) and the fix and a drill, in both languages.
const T = {
  pt: { fh: 'Forehand', bh: 'Backhand', stroke: 'Golpes de fundo (lado não identificado)', serve: 'Saque',
    clear: 'claro', hint: 'tendência',
    zoneT: 'Altura do contato', zone: (o) => `${pct(o.share)} dos seus golpes foram batidos entre ${m1(0.75)} e ${m1(1.3)} (cintura ao peito). Nesses, ${pct(o.inA)} entraram; fora dessa faixa, ${pct(o.inB)} (${o.nA} contra ${o.nB} golpes).`,
    zoneFix: 'Ajuste a distância com passos curtos antes do golpe para encontrar a bola entre a cintura e o peito: recue para a bola alta, chegue antes na bola baixa e dobre os joelhos.', zoneDrill: 'bate-bola com o professor chamando "alta" ou "baixa"; em cada uma, conte os passinhos de ajuste e congele a posição no contato.',
    deepT: 'Onde você encontra a bola', deep: (o) => `${pct(o.share)} dos golpes foram batidos mais de ${m1(1.5)} atrás da linha de fundo. Desses, ${pct(o.inA)} entraram; perto da linha, ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    deepFix: 'Fique mais perto da linha de fundo e encontre a bola no topo ou ainda subindo; recuar muito deixa a bola cair e encurta o seu golpe.', deepDrill: 'rali com um cone 1 m atrás da linha de fundo que você não pode ultrapassar.',
    timeT: 'Quando, depois do quique', time: (o) => `Mediana de ${sec(o.m)} entre o quique da bola do adversário e o seu golpe. Golpes no topo do quique (${sec(0.3)}–${sec(0.65)}): ${pct(o.inA)} dentro; caindo (mais de ${sec(0.65)}): ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    timeFix: 'Prepare cedo (giro de ombros assim que a bola sai da raquete do adversário) e avance para pegar a bola no topo, sem deixá-la cair até a altura do joelho.', timeDrill: 'diga "bate" no quique e "já" no seu contato; o "já" deve vir logo depois do topo.',
    netT: 'Margem sobre a rede', net: (o) => `${pct(o.netShare)} dos seus golpes foram na rede; os que passaram cruzaram, na mediana, ${m1(o.clr)} acima da fita. Com mais de ${m1(0.6)} de folga, ${pct(o.inA)} entraram; com menos, ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    netFix: 'Mire 1 a 1,5 m acima da rede nos golpes de fundo e use o efeito (de baixo para cima) para a bola descer; profundidade vem da altura, não da força.', netDrill: 'corda ou fita 1 m acima da rede; o rali só vale por cima dela.',
    spinT: 'Efeito', spin: (o) => `Com bastante topspin (mais de ${o.cut} rpm), ${pct(o.inA)} dentro; mais chapados, ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    spinFix: 'Swing de baixo para cima: a raquete começa abaixo da bola e termina acima do ombro oposto.', spinDrill: 'bolas ao meio da quadra de serviço com terminação "por cima do ombro" a cada golpe.',
    recT: 'Recuperação', rec: (o) => `1,2 s depois do golpe você estava, na mediana, a ${m1(o.x)} do centro da linha de fundo${o.y != null ? ` e ${m1(Math.abs(o.y))} ${o.y < 0 ? 'atrás' : 'à frente'} dela` : ''}.`,
    recFix: 'Depois de cada golpe, volte com passos laterais para perto do centro e faça o split step quando o adversário for bater.', recDrill: 'dois cones no centro; toque entre eles depois de cada bola.',
    s1T: 'Primeiro e segundo saque', s1: (o) => `Primeiro saque: ${pct(o.in1)} dentro (${o.n1}), mediana ${o.sp1} km/h. Segundo: ${pct(o.in2)} dentro (${o.n2}), ${o.sp2} km/h, ${o.rpm2} rpm.`,
    s1Fix: 'O segundo saque não é um primeiro mais lento: use mais efeito (slice ou kick), mirando mais alto sobre a rede, com o mesmo ritmo de braço.', s1Drill: 'séries de 10 segundos saques com o objetivo de passar 1 m acima da rede e cair na metade de trás da área de saque.',
    tossT: 'Lançamento da bola', toss: (o) => `Topo do lançamento a ${m1(o.z)} na mediana (variação de ±${m1(o.zs)} na altura e ±${m1(o.xs)} para os lados); você bate ${sec(o.dt)} depois do topo. Com o lançamento perto do seu habitual, ${pct(o.inA)} dentro; fora dele, ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    tossFix: 'Lance com o braço esticado, soltando a bola na altura da cabeça, só um pouco acima do ponto mais alto que a raquete alcança, à frente e à direita; um lançamento repetível vale mais que um forte.', tossDrill: 'lance 10 vezes sem bater, com a raquete no chão à frente do pé esquerdo; a bola deve cair nela.',
    szT: 'Altura do contato no saque', sz: (o) => `Contato a ${m1(o.m)} na mediana. Acima disso, ${pct(o.inA)} dentro; abaixo, ${pct(o.inB)} (${o.nA} contra ${o.nB}).`,
    szFix: 'Bata no ponto mais alto que alcança, com o braço esticado e o corpo subindo (empurre o chão com as pernas na posição de troféu).', szDrill: 'saques de joelhos em frente a uma parede para sentir o braço todo estendido; depois a posição de troféu parada por 1 s antes de subir.',
    revFix: 'Aqui os seus números vão contra o que os treinadores costumam recomendar. Pode ser o tipo de bola (defesas, bolas altas) e não a técnica: compare os dois exemplos no vídeo antes de mudar algo.',
    title: 'Técnica: o que funciona para você', shots: 'golpes', fixL: 'Correção', drillL: 'Treino', best: 'Ver o melhor', worst: 'Ver um que não entrou', few: 'Ainda poucos golpes deste tipo para comparar (precisa de 8 em cada grupo).', none: 'Nada a apontar com os golpes desta sessão.',
    intro: 'Comparações entre os seus próprios golpes desta sessão, e o que os treinadores recomendam. É uma correlação numa sessão, não uma prova de causa: use como pista e confira no vídeo.' },
  en: { fh: 'Forehand', bh: 'Backhand', stroke: 'Groundstrokes (side not told)', serve: 'Serve',
    clear: 'clear', hint: 'trend',
    zoneT: 'Contact height', zone: (o) => `${pct(o.share)} of your shots were met between ${m1(0.75)} and ${m1(1.3)} (waist to chest). Of those, ${pct(o.inA)} went in; outside that band, ${pct(o.inB)} (${o.nA} against ${o.nB} shots).`,
    zoneFix: 'Adjust your distance with small steps before the shot to meet the ball between waist and chest: back off for a high ball, get there earlier for a low one and bend your knees.', zoneDrill: 'rally with the coach calling "high" or "low"; count your adjustment steps and freeze at contact.',
    deepT: 'Where you meet the ball', deep: (o) => `${pct(o.share)} of your shots were struck more than ${m1(1.5)} behind the baseline. Of those, ${pct(o.inA)} went in; near the line, ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    deepFix: 'Stay closer to the baseline and take the ball at the top of its bounce or still rising; backing off lets it drop and shortens your stroke.', deepDrill: 'rally with a cone 1 m behind the baseline you may not go past.',
    timeT: 'When, after the bounce', time: (o) => `Median ${sec(o.m)} between the bounce of the opponent's ball and your shot. Shots at the top of the bounce (${sec(0.3)}–${sec(0.65)}): ${pct(o.inA)} in; dropping (over ${sec(0.65)}): ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    timeFix: 'Prepare early (turn the shoulders as soon as the ball leaves the opponent\'s racket) and move in to take the ball at the top, not let it fall to knee height.', timeDrill: 'say "bounce" at the bounce and "hit" at your contact; "hit" should come just after the top.',
    netT: 'Margin over the net', net: (o) => `${pct(o.netShare)} of your shots went into the net; the others crossed a median ${m1(o.clr)} above the tape. With more than ${m1(0.6)} to spare, ${pct(o.inA)} went in; with less, ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    netFix: 'Aim 1 to 1.5 m over the net on groundstrokes and let spin (low to high) bring the ball down; depth comes from height, not force.', netDrill: 'a rope or tape 1 m above the net; a rally only counts over it.',
    spinT: 'Spin', spin: (o) => `With plenty of topspin (over ${o.cut} rpm), ${pct(o.inA)} in; flatter, ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    spinFix: 'Swing low to high: the racket starts below the ball and finishes above the opposite shoulder.', spinDrill: 'balls to the middle of the service box with an "over the shoulder" finish every time.',
    recT: 'Recovery', rec: (o) => `1.2 s after the shot you were a median ${m1(o.x)} from the centre of the baseline${o.y != null ? ` and ${m1(Math.abs(o.y))} ${o.y < 0 ? 'behind' : 'inside'} it` : ''}.`,
    recFix: 'After each shot, side-step back near the centre and split step as the opponent hits.', recDrill: 'two cones at the centre; touch between them after every ball.',
    s1T: 'First and second serve', s1: (o) => `First serve: ${pct(o.in1)} in (${o.n1}), median ${o.sp1} km/h. Second: ${pct(o.in2)} in (${o.n2}), ${o.sp2} km/h, ${o.rpm2} rpm.`,
    s1Fix: 'A second serve is not a slower first serve: use more spin (slice or kick), aim higher over the net, keep the same arm speed.', s1Drill: 'sets of 10 second serves that must clear the net by 1 m and land in the back half of the box.',
    tossT: 'Toss', toss: (o) => `Top of the toss at a median ${m1(o.z)} (±${m1(o.zs)} in height, ±${m1(o.xs)} sideways); you hit ${sec(o.dt)} after the top. With the toss near your usual spot, ${pct(o.inA)} in; away from it, ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    tossFix: 'Toss with a straight arm, releasing at head height, only a little above the highest point your racket reaches, in front and to the right; a repeatable toss beats a big one.', tossDrill: 'toss 10 times without hitting, racket on the ground in front of your left foot; the ball should land on it.',
    szT: 'Serve contact height', sz: (o) => `Contact at a median ${m1(o.m)}. Above that, ${pct(o.inA)} in; below, ${pct(o.inB)} (${o.nA} against ${o.nB}).`,
    szFix: 'Hit at the highest point you can reach, arm straight and body rising (push off the ground from the trophy position).', szDrill: 'serves from your knees facing a wall to feel the arm fully extended; then hold the trophy position 1 s before going up.',
    revFix: 'Here your numbers go against what coaches usually recommend. It may be the kind of ball (defensive shots, high balls) rather than technique: compare the two examples on the video before changing anything.',
    title: 'Technique: what works for you', shots: 'shots', fixL: 'Fix', drillL: 'Drill', best: 'See the best', worst: 'See one that missed', few: 'Not enough shots of this kind to compare yet (8 per group needed).', none: 'Nothing to point out from this session\'s shots.',
    intro: 'Comparisons between your own shots in this session, and what coaches recommend. A link within one session is not proof of cause: take it as a lead and check it on the video.' } };
export const tx = k => (T[getLang()] || T.pt)[k];

// shots: the session's shots; strokeName(q) -> 'fh' | 'bh' | '' for a groundstroke. Returns [{ kind, n, notes: [{ id, level, title, text, fix, drill, best, worst }] }]
export function techniqueNotes(shots, strokeName) { const L = T[getLang()] || T.pt, mine = shots.filter(q => !q.far && (q.who || 'me') === 'me').sort((a, b) => a.t - b.t), opp = shots.filter(q => q.far).sort((a, b) => a.t - b.t), out = [];
  const cmp = (A, B) => { const z = zOf(A, B); return A.length >= MIN && B.length >= MIN && Math.abs(inRate(A) - inRate(B)) >= 0.12 && Math.abs(z) >= 1 ? (Math.abs(z) >= 1.65 ? 'clear' : 'hint') : null; };
  const note = (id, A, B, vals, extra = {}) => { const level = cmp(A, B); if (!level) return null; const rev = inRate(A) < inRate(B), good = rev ? B : A, bad = rev ? A : B; return { id, level, rev, z: Math.abs(zOf(A, B)) * (rev ? 0.8 : 1), title: L[id + 'T'], text: L[id]({ ...vals, inA: inRate(A), inB: inRate(B), nA: A.length, nB: B.length }), fix: rev ? L.revFix : L[id + 'Fix'], drill: rev ? null : L[id + 'Drill'], best: bestOf(good), worst: worstOf(bad), ...extra }; }; // rev: the player's own numbers go against the usual advice; the advice is then not given
  // groundstrokes, by side when it is known
  const ground = mine.filter(q => !q.serve), groups = { fh: [], bh: [], stroke: [] }; for (const q of ground) groups[strokeName(q) || 'stroke'].push(q);
  if (groups.fh.length + groups.bh.length < 0.5 * ground.length) { groups.stroke = ground; groups.fh = []; groups.bh = []; } // sides mostly unknown: one group
  for (const kind of ['fh', 'bh', 'stroke']) { const G = groups[kind]; if (G.length < 6) continue; const notes = [], met = G.filter(q => (q.hit || q.heard) && q.p0); // contact known only when the hit was seen or heard
    if (met.length >= 2 * MIN) { const A = met.filter(q => q.p0[2] >= 0.75 && q.p0[2] <= 1.3), B = met.filter(q => !(q.p0[2] >= 0.75 && q.p0[2] <= 1.3)); notes.push(note('zone', A, B, { share: A.length / met.length }));
      const D = met.filter(q => q.p0[1] < -1.5), N = met.filter(q => q.p0[1] >= -1.5); notes.push(note('deep', D, N, { share: D.length / met.length })); }
    { const tm = []; for (const q of G) { let p = null; for (const o of opp) { if (o.t >= q.t) break; p = o; } if (!p || !p.tLand) continue; const dt = q.t - (p.t + p.tLand); if (dt > 0.05 && dt < 1.6) tm.push([q, dt]); }
      if (tm.length >= 2 * MIN) { const A = tm.filter(x => x[1] >= 0.3 && x[1] <= 0.65).map(x => x[0]), B = tm.filter(x => x[1] > 0.65).map(x => x[0]); notes.push(note('time', A, B, { m: med(tm.map(x => x[1])) })); } }
    { const over = G.filter(q => q.result !== 'net' && q.clear != null), A = over.filter(q => q.clear > 0.6), B = G.filter(q => q.result === 'net' || (q.clear != null && q.clear <= 0.6)); const n = note('net', A, B, { netShare: G.filter(q => q.result === 'net').length / G.length, clr: med(over.map(q => q.clear)) }); if (n) notes.push(n); }
    { const cut = 1200, A = G.filter(q => q.rpm > cut), B = G.filter(q => !(q.rpm > cut)); notes.push(note('spin', A, B, { cut })); }
    { const R = G.filter(q => q.rec); if (R.length >= 2 * MIN) { const x = med(R.map(q => Math.abs(q.rec[0]))), y = med(R.map(q => q.rec[1])); if (x > 1.5 || y < -2.5) notes.push({ id: 'rec', level: 'info', z: 0.5, title: L.recT, text: L.rec({ x, y }), fix: L.recFix, drill: L.recDrill, best: null, worst: null }); } }
    out.push({ kind, title: L[kind], n: G.length, notes: notes.filter(Boolean).sort((a, b) => b.z - a.z).slice(0, 3) }); }
  // serves
  const S = mine.filter(q => q.serve); if (S.length >= 6) { const notes = [], first = [], second = [];
    for (let i = 0; i < S.length; i++) { const p = S[i - 1], q = S[i], between = p ? mine.some(r => r.t > p.t && r.t < q.t) || opp.some(r => r.t > p.t + 1.5 && r.t < q.t - 0.5) : true; (p && !between && p.result !== 'in' && q.t - p.t < 40 && first.includes(p) ? second : first).push(q); } // a serve right after a missed first serve, with no rally in between, is a second serve
    if (first.length >= MIN && second.length >= 5) notes.push({ id: 's1', level: 'info', z: 1, title: L.s1T, text: L.s1({ in1: inRate(first), n1: first.length, sp1: Math.round(med(first.map(q => q.speed))), in2: inRate(second), n2: second.length, sp2: Math.round(med(second.map(q => q.speed))), rpm2: Math.round(med(second.map(q => q.rpm)) / 10) * 10 }), fix: L.s1Fix, drill: L.s1Drill, best: bestOf(second), worst: worstOf(second) });
    { const tz = S.filter(q => q.toss && q.toss.top); if (tz.length >= 2 * MIN) { const mz = med(tz.map(q => q.toss.z)), mx = med(tz.map(q => q.toss.x)), A = tz.filter(q => Math.abs(q.toss.z - mz) <= 0.3 && Math.abs(q.toss.x - mx) <= 0.3), B = tz.filter(q => !A.includes(q)); const n = note('toss', A, B, { z: mz, zs: sd(tz.map(q => q.toss.z)), xs: sd(tz.map(q => q.toss.x)), dt: med(tz.map(q => q.toss.dt)) }); if (n) notes.push(n); } }
    { const H = S.filter(q => q.p0), m = med(H.map(q => q.p0[2])); if (H.length >= 2 * MIN) notes.push(note('sz', H.filter(q => q.p0[2] >= m), H.filter(q => q.p0[2] < m), { m })); }
    out.push({ kind: 'serve', title: L.serve, n: S.length, notes: notes.filter(Boolean).sort((a, b) => b.z - a.z).slice(0, 3) }); }
  return out; }
