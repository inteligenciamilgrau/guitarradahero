# 🎸 GUITARRADA HERO

### *"Queremos ver se o Brasil já está pronto pra tocar as músicas do Ximbinha"*

Um jogo de ritmo em **Three.js** — homenagem ao **Ximbinha**, à **guitarrada
paraense** e aos guitarristas e músicos brasileiros.

Feito por **MEGA BRAIN GAMES BR** *(estúdio fictício — é piada)*.

> ⚠️ **Projeto didático, sem fins comerciais.**
> Todas as músicas são **composições originais geradas proceduralmente** em
> WebAudio. Nenhuma gravação, composição ou arte de terceiros é usada.
> Os nomes de artistas reais aparecem **apenas como homenagem textual**.
> Não afiliado a nenhum artista, banda, gravadora ou publisher.

---

## Jogar

**Não precisa instalar nada, não precisa de servidor, não precisa de build.**

Abra o `index.html` no navegador. É isso.

Ou jogue direto pelo GitHub Pages (link na aba *About* do repositório).

**Primeira vez?** Escolha **Tutorial** no menu principal: em uns três minutos
ele ensina, tocando, os trastes, a palhetada, o bastão (nota aberta), as notas
longas, os acordes e o Star Power.

### Controles

| Ação | Tecla |
|---|---|
| Trastes (5 raias) | `A` `S` `D` `F` `G` — ou `1` `2` `3` `4` `5` |
| Palhetada | `↑` / `↓` |
| Star Power | `Espaço` |
| Pausa | `Esc` |
| Recomeçar (na pausa e no resultado) | `R` |

Também funciona com **gamepad**. Se estiver errando tudo, vá em
**Opções → Calibração** e ajuste a latência do seu setup — em jogo de ritmo isso
faz toda a diferença.

Em **Opções → Qualidade** há três níveis: **Leve** (PC fraco ou notebook
simples), **Média** e **Alta** (PC com placa de vídeo). Na primeira abertura o
jogo sugere um pela placa de vídeo do PC, e baixa sozinho se a música engasgar.

---

## O que tem dentro

- **6 músicas originais**, compostas proceduralmente em 6 gêneros brasileiros:
  guitarrada, carimbó, lambada, brega, frevo e samba-rock.
- **4 dificuldades** por música — a mais difícil se chama **Guitarrada**. No
  Fácil e no Médio as 3 ou 4 raias trocam de lado a cada Star Power (meio,
  direita, esquerda...), para todos os dedos treinarem; setas embaixo dos
  aros avisam a troca.
- **Tutorial interativo** em 8 lições curtas, com banda tocando junto: cada
  lição só passa quando o jogador bate a meta, e um "treinador" explica cada
  erro na hora (faltou palhetar, tecla errada, soltou cedo...). As teclas
  mostradas são as que o jogador configurou.
- **Toda a trilha é composta e sintetizada proceduralmente** no WebAudio:
  guitarra com distorção valvulada, wah, tremolo e delay slapback; baixo;
  bateria; percussão brasileira; órgão e naipe de metais. Um gerador offline
  preserva esses timbres em três stems sincronizados (`backing`, `drums` e
  `guitar`), evitando milhares de nós de áudio durante a partida.
- **Todas as texturas da cena são desenhadas em canvas 2D em tempo de execução** —
  madeira, metal escovado, fibra de carbono, grafismo marajoara, azulejaria.
  O único bitmap de interface é o favicon.
- Palco com público instanciado, rig de luz com cones volumétricos, telão de
  LED reativo, fumaça e cenário amazônico.
- Mecânicas completas do gênero: acordes, HOPO, tap notes, sustains, notas
  abertas, overstrum, rock meter, Star Power e multiplicador até 8×.

---

## Como foi feito

Three.js **r147** (build UMD, vendorizado em `vendor/`), carregado com
`<script>` clássico — **sem módulos ES, sem bundler, sem `npm install`,
sem dependência em runtime**. Isso é o que permite abrir o arquivo direto do
disco e o que torna o deploy no Pages trivial.

```
index.html          shell + ordem de carregamento
favicon.png         ícone do navegador
src/core/           util, paleta, engine (render + post-processing), input
src/visual/         materiais procedurais, pista, notas, efeitos, palco
src/audio/          grafo, síntese, stems e maestro (relógio)
src/content/        músicas e charts
src/gameplay/       chart, pontuação, máquina de estados
src/ui/             HUD e menus
tools/generate-*    gerador offline de stems para músicas atuais e futuras
vendor/             Three.js r147 + EffectComposer / Bloom / SMAA
```

Os MP3s finais ficam em `assets/audio/<song-id>/` e fazem parte da distribuição.
O gerador cria primeiro WAVs sem perdas, comprime com FFmpeg/LAME em 256 kb/s e
mantém esses WAVs intermediários fora do Git. Para gerar ou regerar uma música
no Windows, com Edge ou Chrome e FFmpeg instalados:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\generate-stems.ps1 -SongId frevo-de-aco -Stem all
```

O script atualiza o manifesto somente depois que `backing.mp3`, `drums.mp3` e
`guitar.mp3` foram concluídos e validados. Se os arquivos não estiverem
presentes, o jogo continua funcionando pelo sintetizador procedural de fallback.
As demais ferramentas de desenvolvimento e a documentação interna continuam
fora do repositório.

Um detalhe de implementação que vale contar: como não há build nem servidor, o
carregamento é `<script>` clássico com `window.GH` como namespace, e cada módulo
é um IIFE. É o que permite abrir o `index.html` com dois cliques — módulos ES
são bloqueados em `file://`.

---

## Homenagem

A guitarrada é um gênero instrumental nascido no Pará, na virada dos anos 1970,
misturando carimbó, lambada, merengue, cúmbia e guitarra elétrica.

Este projeto é uma homenagem a **Ximbinha**, a **Mestre Vieira**, **Aldo Sena**,
**Beto Metralha**, **Pinduca** e a todos os mestres da guitarrada paraense — e,
por extensão, aos guitarristas e músicos brasileiros.

---

## Licença

Código sob **MIT**. As homenagens são homenagens: nomes de artistas reais citados
neste projeto pertencem a eles, e são mencionados aqui em caráter educativo e
afetivo, sem qualquer vínculo comercial ou de representação.
