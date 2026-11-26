import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createBackendApp, type QuickToneBackendApp } from '../packages/backend/src/index.js';
import { MockMidiAdapter } from '../packages/midi-service/src/index.js';
import { buildNuxPresetBinary } from '../packages/quicktone-reader/src/index.js';

test.describe('QuickTone Web Controller — Testes E2E Full-Stack (Playwright)', () => {
  let tempDir: string;
  let mockMidi: MockMidiAdapter;
  let server: QuickToneBackendApp;
  let baseUrl: string;

  test.beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quicktone-e2e-'));

    // Cria arquivos .nuxpreset binários reais na pasta monitorada
    const eaglesBin = buildNuxPresetBinary({
      name: 'EaglesDF Crunch',
      slotIndex: 0,
      patchVolume: 50,
      irVolume: 23,
      formatVersion: 'v1',
    });
    const scorpionsBin = buildNuxPresetBinary({
      name: 'SCORPIONS',
      slotIndex: 1,
      patchVolume: 68,
      irVolume: 30,
      formatVersion: 'v1',
    });

    fs.writeFileSync(path.join(tempDir, '01_EaglesDF Crunch.nuxpreset'), eaglesBin);
    fs.writeFileSync(path.join(tempDir, '02_SCORPIONS.nuxpreset'), scorpionsBin);

    mockMidi = new MockMidiAdapter({
      autoConfirmHardware: false,
    });

    server = createBackendApp({
      midiAdapter: mockMidi,
      midiOptions: {
        autoReconnect: true,
        reconnectIntervalMs: 60,
      },
      presetsDirectory: tempDir,
      includeFactoryPresets: true,
      autoConnectMidiOnInit: true,
      experimentalEdit: true,
      experimentalBackupDir: path.join(tempDir, 'backups'),
    });

    await server.stateManager.initialize();
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address;
  });

  test.afterEach(async () => {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('1. QuickTone até Interface & MIDI Mock: renderiza presets reais .nuxpreset, envia CC 60 sem falsificar confirmação e confirma via MIDI IN', async ({
    page,
  }) => {
    await page.goto(baseUrl);

    // Verifica barra superior fixa, conexão MIDI e presets carregados da pasta QuickTone
    await expect(page.getByTestId('top-bar')).toBeVisible();
    await expect(page.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(page.getByTestId('preset-card-1A')).toBeVisible();
    await expect(page.getByTestId('preset-name-1A')).toHaveText('EaglesDF Crunch');
    await expect(page.getByTestId('preset-name-1B')).toHaveText('SCORPIONS');

    // Estado inicial deve ser 'unknown' (nenhum comando enviado ou confirmado ainda)
    await expect(page.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'unknown',
    );

    // Clica no preset 1B ("SCORPIONS")
    await page.getByTestId('preset-card-1B').click();

    // Deve exibir "COMANDO ENVIADO" (não confirmado) e ter enviado [0xB0, 0x3C, 0x01] ao MockMidiAdapter
    await expect(page.getByTestId('preset-card-1B')).toHaveAttribute(
      'data-status',
      'command_sent_unconfirmed',
    );
    await expect(page.getByTestId('preset-status-sent-1B')).toHaveText('Enviando…');
    await expect(page.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'command_sent_unconfirmed',
    );

    const sentMessages = mockMidi.getSentMessages();
    expect(sentMessages).toContainEqual([0xb0, 0x3c, 0x01]);

    // Simula resposta de confirmação real da NUX MG-300 via MIDI IN ([0xB0, 0x3C, 0x01])
    mockMidi.simulateHardwareIncoming([0xb0, 0x3c, 0x01]);

    // Interface deve atualizar instantaneamente via WebSocket para "Ativo"
    await expect(page.getByTestId('preset-card-1B')).toHaveAttribute(
      'data-status',
      'confirmed',
    );
    await expect(page.getByTestId('preset-status-confirmed-1B')).toHaveText('Ativo');
    await expect(page.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'confirmed',
    );
  });

  test('2. Dois clientes sincronizados em tempo real via WebSocket (troca de preset e volume)', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(baseUrl);
    await pageB.goto(baseUrl);

    await expect(pageA.getByTestId('ws-connection-badge')).toHaveAttribute(
      'data-ws-status',
      'connected',
    );
    await expect(pageB.getByTestId('ws-connection-badge')).toHaveAttribute(
      'data-ws-status',
      'connected',
    );

    // Cliente A seleciona o preset 1A ("EaglesDF Crunch")
    await pageA.getByTestId('preset-card-1A').click();

    // Cliente B deve ver imediatamente o preset 1A como comando enviado
    await expect(pageB.getByTestId('preset-card-1A')).toHaveAttribute(
      'data-status',
      'command_sent_unconfirmed',
    );

    // Quando a pedaleira confirma via MIDI IN, ambos os clientes A e B mostram CONFIRMADO
    mockMidi.simulateHardwareIncoming([0xb0, 0x3c, 0x00]);
    await expect(pageA.getByTestId('preset-card-1A')).toHaveAttribute(
      'data-status',
      'confirmed',
    );
    await expect(pageB.getByTestId('preset-card-1A')).toHaveAttribute(
      'data-status',
      'confirmed',
    );

    // Cliente A aumenta o volume clicando no botão tátil +5 (Master Volume)
    await pageA.getByTestId('volume-increase-btn').click();
    await expect(pageA.getByTestId('volume-value')).toHaveText('55%');
    await expect(pageB.getByTestId('volume-value')).toHaveText('55%');

    // Alterna filtros Usuário / Fábrica e Palco <-> Bancos + valida Editor oculto em Fábrica
    await pageA.getByTestId('filter-tab-factory').click();
    await expect(pageA.getByTestId('preset-card-F1A')).toBeVisible();
    await pageA.getByTestId('preset-card-F1A').click();
    await expect(pageA.getByTestId('open-tone-editor-btn')).toHaveCount(0);
    await pageA.getByTestId('filter-tab-user').click();
    await pageA.getByTestId('view-mode-stage-btn').click();
    await expect(pageA.getByTestId('stage-footswitch-deck')).toBeVisible();
    await pageA.getByTestId('view-mode-matrix-btn').click();

    await contextA.close();
    await contextB.close();
  });

  test('3. Desconexão inesperada do USB-MIDI e recuperação automática propagada até a interface', async ({
    page,
  }) => {
    await page.goto(baseUrl);

    await expect(page.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );

    // Simula remoção física do cabo USB da MG-300
    mockMidi.simulateUnexpectedDisconnect('USB cable unplugged');

    // A interface deve refletir o estado de reconexão / erro
    await expect(page.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-connection-state',
      'reconnecting',
    );

    // Simula reconexão do cabo USB da MG-300
    mockMidi.simulateDeviceReconnected();

    // O serviço MIDI reconecta automaticamente e notifica a interface via WebSocket
    await expect(page.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
  });

  test('4. ToneEditorDrawer: focus trap (Tab/Shift+Tab), Escape em camadas, restauração de foco e alvos táteis mobile >= 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(baseUrl);

    await expect(page.getByTestId('preset-card-1A')).toBeVisible();
    await page.getByTestId('preset-card-1A').click();
    mockMidi.simulateHardwareIncoming([0xb0, 0x3c, 0x00]);
    await expect(page.getByTestId('open-tone-editor-btn')).toBeVisible();

    // Altura tátil >= 44px nos chips clicáveis de StageDisplay no viewport mobile
    const firstChipBox = await page
      .locator('[data-testid="signal-chain-strip"] button[data-block="AMP"]')
      .boundingBox();
    expect(firstChipBox).not.toBeNull();
    expect(firstChipBox!.height).toBeGreaterThanOrEqual(44);

    // Zero overflow horizontal em 375px
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

    // Abre editor via botão Criar novo timbre para testar rascunho dirty e focus trap
    const createBtn = page.getByTestId('create-tone-btn');
    await createBtn.focus();
    await createBtn.click();

    const drawer = page.getByTestId('experimental-edit-panel');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('exp-preset-name-input')).toBeVisible();

    // Focus trap mantém foco dentro do drawer em Tab e Shift+Tab
    const closeBtn = page.getByTestId('close-tone-editor-btn');
    await closeBtn.focus();
    await page.keyboard.press('Shift+Tab');
    const activeInsideAfterShiftTab = await drawer.evaluate((el) =>
      el.contains(document.activeElement),
    );
    expect(activeInsideAfterShiftTab).toBe(true);

    const saveBtn = page.getByTestId('exp-save-btn');
    await saveBtn.focus();
    await page.keyboard.press('Tab');
    const activeInsideAfterTab = await drawer.evaluate((el) =>
      el.contains(document.activeElement),
    );
    expect(activeInsideAfterTab).toBe(true);

    // Escape em camadas: inline-save-panel -> fecha painel -> Escape -> abre dirty guard -> Escape -> fecha banner
    await saveBtn.click();
    await expect(page.getByTestId('inline-save-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inline-save-panel')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dirty-guard-banner')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dirty-guard-banner')).toHaveCount(0);

    // Descartar alterações fecha o drawer e restaura foco ao botão de abertura
    await page.keyboard.press('Escape');
    await page.getByTestId('confirm-discard-dirty-btn').click();
    await expect(drawer).toHaveCount(0);
    await expect(createBtn).toBeFocused();
  });
});
