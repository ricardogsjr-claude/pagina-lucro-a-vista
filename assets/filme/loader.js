/* filme-loader v1 — R01 "O Ouro é Luz"
 *
 * Implementação de referência do contrato descrito em MANIFEST.json.
 * Substitui o par SEQ/IMGS do demo_ouro_e_luz.html.
 *
 * O que ele resolve, além do peso:
 *  - 662 requisições viram 27 (desktop) / 23 (celular): cada pack é a
 *    CONCATENAÇÃO CRUA dos WebP de um trecho de clipe.
 *  - o demo mantinha 662 <img> vivos; decodificados isso é ~1,9 GB de RGBA
 *    (o iOS mata a aba). Aqui os BYTES ficam na memória (10,5 MB / 5,1 MB) e
 *    só uma JANELA de ImageBitmap fica decodificada, com close() nos que saem.
 *
 * Resolução não é uniforme no tier celular: o clipe `zoomjoia` roda em
 * 880x1092 (os outros em 660x819). O loader não precisa saber disso — ele
 * fatia por offset e o drawImage do canvas escala. Só a conta de memória muda:
 * a janela dentro do zoomjoia custa ~3,8 MB por quadro em vez de ~2,2 MB.
 */
(function (global) {
  'use strict';

  function Filme(base, opts) {
    opts = opts || {};
    this.base = base.replace(/\/$/, '') + '/';
    this.janela = opts.janela || 20;      // ±quadros decodificados
    this.ix = null;
    this.bytes = {};                       // clipe -> Uint8Array por pack
    this.bmp = {};                         // "clipe:i" -> ImageBitmap
    this.ordem = [];                       // ordem de uso, p/ despejar os antigos
    this.baixando = {};
  }

  Filme.tier = function () {
    // celular por largura E por dado economizado (perf-budget §4)
    var c = navigator.connection || {};
    var magro = c.saveData || /2g|3g/.test(c.effectiveType || '');
    return (matchMedia('(max-width:820px)').matches || magro) ? 'mobile' : 'desktop';
  };

  Filme.prototype.abrir = function () {
    var self = this;
    return fetch(this.base + 'index.json').then(function (r) { return r.json(); })
      .then(function (ix) {
        self.ix = ix;
        self.SEG = ix.SEG;               // use ESTE SEG, não o do demo
        return self.pack(ix.SEG[0].trecho, 0);   // abertura: só o 1º pack
      }).then(function () { return self.ix; });
  };

  /* baixa o pack de índice `p` do clipe `c` (idempotente) */
  Filme.prototype.pack = function (c, p) {
    var self = this, k = c + ':' + p;
    if (this.baixando[k]) return this.baixando[k];
    var meta = this.ix.clipes[c].packs[p];
    if (!meta) return Promise.resolve();
    this.baixando[k] = fetch(this.base + meta.arquivo)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (b) { (self.bytes[c] = self.bytes[c] || {})[p] = new Uint8Array(b); });
    return this.baixando[k];
  };

  /* baixa o clipe inteiro — chame pelo IntersectionObserver a ~1,5 viewport */
  Filme.prototype.clipe = function (c) {
    var self = this;
    return Promise.all(this.ix.clipes[c].packs.map(function (_, p) { return self.pack(c, p); }));
  };

  /* baixa os packs do clipe `c` até o quadro `q`, mais `folga` packs à frente.
   * É a granularidade de PACK: o clipe de ABERTURA não precisa vir inteiro para
   * o palco desenhar o quadro 0 — no celular `quebra` são 9 packs / 4,2 MB, e a
   * primeira viewport de scrub consome 3. Mesma lógica de proximidade que o
   * `clipe()` já dá entre clipes, aplicada DENTRO do clipe. */
  Filme.prototype.ateQuadro = function (c, q, folga) {
    var packs = this.ix.clipes[c].packs, alvo = 0, ps = [];
    for (var p = 0; p < packs.length; p++) if (q >= packs[p].de) alvo = p;
    var fim = Math.min(packs.length - 1, alvo + (folga || 0));
    for (var k = 0; k <= fim; k++) ps.push(this.pack(c, k));
    return Promise.all(ps);
  };

  Filme.prototype.acha = function (c, i) {
    var packs = this.ix.clipes[c].packs;
    for (var p = 0; p < packs.length; p++)
      if (i >= packs[p].de && i <= packs[p].ate) return { p: p, e: packs[p].quadros[i - packs[p].de] };
    return null;
  };

  /* garante o ImageBitmap do quadro i do clipe c (assíncrono, sem bloquear o scroll) */
  Filme.prototype.decodifica = function (c, i) {
    var k = c + ':' + i;
    if (this.bmp[k]) return this.bmp[k];
    var loc = this.acha(c, i);
    if (!loc) return null;
    var buf = this.bytes[c] && this.bytes[c][loc.p];
    if (!buf) { this.pack(c, loc.p); return null; }            // ainda não chegou
    var self = this;
    this.bmp[k] = 'pendente';
    var fatia = buf.subarray(loc.e[0], loc.e[0] + loc.e[1]);
    createImageBitmap(new Blob([fatia], { type: 'image/webp' })).then(function (b) {
      self.bmp[k] = b; self.ordem.push(k); self.despeja();
      if (self.aoDecodificar) self.aoDecodificar(c, i);
    }).catch(function () { delete self.bmp[k]; });
    return null;
  };

  Filme.prototype.despeja = function () {
    // teto DECLARADO no MANIFEST §5: janela deslizante de ±janela quadros da
    // posicao (= 2*janela+1 = 41 bitmaps), ~154 MB no desktop / ~86 MB no
    // celular. Antes o teto era janela*4 = 80, o dobro do declarado.
    var teto = this.janela * 2 + 1;
    while (this.ordem.length > teto) {
      var k = this.ordem.shift(), b = this.bmp[k];
      if (b && b.close) b.close();
      delete this.bmp[k];
    }
  };

  /* o quadro para desenhar AGORA. Pré-decodifica a janela à frente e atrás. */
  Filme.prototype.quadro = function (c, i) {
    var n = this.ix.clipes[c].n, k = c + ':' + i, pronto = this.bmp[k];
    if (pronto === 'pendente') pronto = null;
    for (var d = 0; d <= this.janela; d++) {
      if (i + d < n) this.decodifica(c, i + d);
      if (i - d >= 0) this.decodifica(c, i - d);
    }
    if (pronto) return pronto;
    // fallback: o mais próximo já decodificado, para nunca pintar em branco
    for (var d2 = 1; d2 <= n; d2++) {
      var a = this.bmp[c + ':' + (i - d2)], b = this.bmp[c + ':' + (i + d2)];
      if (a && a !== 'pendente') return a;
      if (b && b !== 'pendente') return b;
    }
    return null;
  };

  /* ponte com o desenho do demo: p (0..1) -> quadro
     idêntico ao demo_ouro_e_luz.html, só que sobre o SEG reescrito */
  Filme.prototype.emP = function (p, SEGcomAB) {
    var s = SEGcomAB[SEGcomAB.length - 1];
    for (var k = 0; k < SEGcomAB.length; k++) if (p < SEGcomAB[k].b) { s = SEGcomAB[k]; break; }
    var f = Math.min(1, Math.max(0, (p - s.a) / (s.b - s.a)));
    var t = s.de + (s.ate - s.de) * f;
    var n = this.ix.clipes[s.trecho].n;
    return this.quadro(s.trecho, Math.min(n - 1, Math.max(0, Math.round(t * (n - 1)))));
  };

  global.Filme = Filme;
})(window);
