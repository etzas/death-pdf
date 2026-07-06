# Death PDF

Leitor e anotador de PDF para desktop — minimalista, com modo escuro que inverte
as cores do PDF, caneta sensivel a pressao (mesa digitalizadora), marca-texto,
borracha e **todos os atalhos configuraveis**.

Alvo principal: **Windows**. Desenvolvimento/teste: **Linux (AlmaLinux 9)**.
Feito com Electron + PDF.js. Roda offline (PDF.js e pdf-lib ja vem embutidos).

---

## 1. Testar durante o desenvolvimento (no AlmaLinux)

Precisa do **Node.js 18+** (`sudo dnf install nodejs` ou https://nodejs.org).

```bash
npm install     # baixa o Electron (so na primeira vez)
npm start       # abre o app
```

Editou algo em `src/`? Roda `npm start` de novo.

Para testar o app ja "empacotado" no Linux (sem depender de FUSE):

```bash
npm run dist:dir
./dist/linux-unpacked/death-pdf
```

---

## 2. Gerar o .exe do Windows pelo GitHub Actions

Como voce desenvolve no Linux mas o alvo e o Windows, o caminho limpo e deixar
o GitHub compilar num Windows de verdade. O workflow ja esta pronto em
`.github/workflows/build-windows.yml`.

### Passo a passo (uma vez)

1. Crie um repositorio no GitHub (pode ser privado).
2. Na pasta do projeto:

   ```bash
   git init
   git add .
   git commit -m "Death PDF"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/death-pdf.git
   git push -u origin main
   ```

3. No GitHub, abra a aba **Actions**. O workflow "Build Windows" aparece.

### Para gerar o instalador

- **Manual:** aba Actions -> "Build Windows" -> botao **Run workflow**.
  Quando terminar, baixe o `.exe` em **Artifacts** (`death-pdf-windows`).

- **Por versao (recomendado):** crie uma tag e o GitHub compila E publica um
  Release com o `.exe` pronto pra baixar:

  ```bash
  git tag v1.0.0
  git push --tags
  ```

  O instalador (`Death PDF Setup 1.0.0.exe`) e a versao portatil
  (`Death-PDF-1.0.0-portable.exe`) aparecem em **Releases**.

> O `.exe` sai **nao-assinado** (sem certificado digital, que e pago). Ao
> instalar, o Windows SmartScreen pode mostrar um aviso — clique em
> "Mais informacoes" -> "Executar assim mesmo". E normal para apps proprios.

---

## 3. Windows reconhecer como leitor de PDF

O instalador registra o Death PDF como um programa que abre `.pdf`. Depois de
instalar, ao clicar com o botao direito num PDF -> **Abrir com** -> **Escolher
outro aplicativo**, o **Death PDF** aparece na lista. Marque "Sempre usar este
aplicativo" se quiser deixa-lo como padrao.

> O Windows nao deixa um app se tornar padrao sozinho na instalacao (protecao do
> sistema) — por isso ele so aparece na lista pra voce escolher. Isso e o
> comportamento esperado no Windows 10/11.

Abrir um PDF pelo "Abrir com" (ou dois cliques, se for o padrao) abre o arquivo
direto no Death PDF. Se o app ja estiver aberto, o PDF carrega na mesma janela.

---

## Funcoes

- **Modo escuro do PDF** — inverte as cores da pagina; suas marcacoes NAO sao
  invertidas. Botao de lua, ou `Ctrl+Shift+D`.
- **Caneta com pressao real** da mesa digitalizadora (Pointer Events +
  `getCoalescedEvents()` para tracos precisos).
- **Marca-texto**, **borracha**, **mao/pan** (ou segure `Espaco`).
- **Zoom** por botoes, `Ctrl + / Ctrl -`, ou `Ctrl + roda do mouse`.
- **Desfazer / Refazer**.
- **Exportar PDF anotado** — gera um PDF novo com os tracos embutidos.
- **Salvamento automatico** das anotacoes num arquivo `.deathpdf.json` ao lado
  do PDF (voltam sozinhas ao reabrir).

## Atalhos (padrao — todos editaveis na engrenagem)

| Acao                    | Atalho              |
|-------------------------|---------------------|
| Abrir PDF               | `Ctrl+O`            |
| Selecionar / Caneta / Marca-texto / Borracha | `V` / `P` / `H` / `E` |
| Mao (temporaria)        | segurar `Espaco`    |
| Modo escuro do PDF      | `Ctrl+Shift+D`      |
| Desfazer / Refazer      | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Zoom + / -              | `Ctrl+=` / `Ctrl+-` |
| Ajustar a largura       | `Ctrl+0`            |
| Proxima / pagina ant.   | `PageDown` / `PageUp` |
| Exportar PDF anotado    | `Ctrl+E`            |
| Preferencias            | `Ctrl+,`            |
| Limpar pagina           | `Ctrl+Shift+Backspace` |

---

## Sobre os avisos do `npm install`

As mensagens de "deprecated" e "high severity vulnerabilities" vem da arvore de
dependencias do **electron-builder** — sao ferramentas de **build**, usadas so na
sua maquina/CI e **nao entram no app final**. Pode ignorar.
**Nao rode `npm audit fix --force`** (quebraria o electron-builder).

## Estrutura

```
death-pdf/
├── package.json
├── main.js                       # janela, instancia unica, abrir-com
├── preload.js
├── assets/                       # icone (.ico / .png)
├── .github/workflows/            # build do Windows no GitHub Actions
└── src/
    ├── index.html
    ├── styles.css
    ├── renderer.js
    └── vendor/                   # PDF.js e pdf-lib (offline)
```
