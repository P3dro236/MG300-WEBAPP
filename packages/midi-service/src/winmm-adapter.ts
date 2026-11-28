import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { type MidiPortInfo } from '@quicktone/shared';
import {
  formatHexBytes,
  getSharedMidiDiagnosticsLogger,
  type MidiDiagnosticsLogger,
} from './diagnostics-logger.js';
import { type IMidiAdapter, isMg300PortName, MidiServiceError } from './types.js';

export interface WinMmMidiAdapterOptions {
  powershellExecutable?: string;
  powershellArgsBuilder?: (scriptPath: string) => string[];
  allowSystemSynth?: boolean;
  commandTimeoutMs?: number;
  logger?: MidiDiagnosticsLogger;
}

const SYSTEM_SYNTH_NAME = 'microsoft gs wavetable synth';

/**
 * Normalizes Windows WinMM IN/OUT port names (`NUX NME-300 MIDI IN` / `NUX NME-300 MIDI OUT`)
 * to their shared device name (`NUX NME-300`) so IN and OUT endpoints pair cleanly as duplex.
 */
export function normalizeMidiBasePortName(rawName: string): string {
  const trimmed = rawName.trim();
  const stripped = trimmed.replace(/\s+(?:MIDI\s*)?(?:IN|OUT)(?:\s+\d+)?$/i, '').trim();
  return stripped.length > 0 ? stripped : trimmed;
}

const WINMM_CSHARP_SOURCE = `
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace QuickToneWinMm {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIOUTCAPSW {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public ushort wTechnology;
    public ushort wVoices;
    public ushort wNotes;
    public ushort wChannelMask;
    public uint dwSupport;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIINCAPSW {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public uint dwSupport;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  public struct MIDIHDR {
    public IntPtr lpData;
    public uint dwBufferLength;
    public uint dwBytesRecorded;
    public IntPtr dwUser;
    public uint dwFlags;
    public IntPtr lpNext;
    public IntPtr reserved;
    public uint dwOffset;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
    public IntPtr[] reservedArray;
  }

  public static class NativeMethods {
    public const uint CALLBACK_FUNCTION = 0x00030000;
    public const uint MIM_OPEN = 0x3C1;
    public const uint MIM_CLOSE = 0x3C2;
    public const uint MIM_DATA = 0x3C3;
    public const uint MIM_LONGDATA = 0x3C4;
    public const uint MIM_ERROR = 0x3C5;
    public const uint MIM_LONGERROR = 0x3C6;
    public const uint MHDR_DONE = 0x00000001;

    public delegate void MidiInProc(IntPtr hMidiIn, uint wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern uint midiOutGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern uint midiOutGetDevCapsW(UIntPtr uDeviceID, out MIDIOUTCAPSW lpMidiOutCaps, uint cbMidiOutCaps);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern uint midiInGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern uint midiInGetDevCapsW(UIntPtr uDeviceID, out MIDIINCAPSW lpMidiInCaps, uint cbMidiInCaps);

    [DllImport("winmm.dll")]
    public static extern uint midiOutOpen(out IntPtr lphmo, uint uDeviceID, IntPtr dwCallback, IntPtr dwCallbackInstance, uint dwFlags);

    [DllImport("winmm.dll")]
    public static extern uint midiOutShortMsg(IntPtr hmo, uint dwMsg);

    [DllImport("winmm.dll")]
    public static extern uint midiOutPrepareHeader(IntPtr hmo, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiOutLongMsg(IntPtr hmo, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiOutUnprepareHeader(IntPtr hmo, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiOutReset(IntPtr hmo);

    [DllImport("winmm.dll")]
    public static extern uint midiOutClose(IntPtr hmo);

    [DllImport("winmm.dll")]
    public static extern uint midiInOpen(out IntPtr lphmi, uint uDeviceID, MidiInProc dwCallback, IntPtr dwCallbackInstance, uint fdwOpen);

    [DllImport("winmm.dll")]
    public static extern uint midiInPrepareHeader(IntPtr hmi, IntPtr lpMidiInHdr, uint cbMidiInHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiInUnprepareHeader(IntPtr hmi, IntPtr lpMidiInHdr, uint cbMidiInHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiInAddBuffer(IntPtr hmi, IntPtr lpMidiInHdr, uint cbMidiInHdr);

    [DllImport("winmm.dll")]
    public static extern uint midiInStart(IntPtr hmi);

    [DllImport("winmm.dll")]
    public static extern uint midiInStop(IntPtr hmi);

    [DllImport("winmm.dll")]
    public static extern uint midiInReset(IntPtr hmi);

    [DllImport("winmm.dll")]
    public static extern uint midiInClose(IntPtr hmi);
  }

  public static class Bridge {
    private const int SYSEX_BUFFER_COUNT = 8;
    private const uint SYSEX_BUFFER_SIZE = 4096;
    private static readonly object _stdoutLock = new object();
    private static readonly ConcurrentQueue<object> _rxQueue = new ConcurrentQueue<object>();
    private static readonly AutoResetEvent _rxEvent = new AutoResetEvent(false);
    private static readonly List<IntPtr> _inHeaders = new List<IntPtr>();
    private static readonly List<IntPtr> _inBuffers = new List<IntPtr>();
    private static NativeMethods.MidiInProc _callbackDelegate;
    private static IntPtr _hIn = IntPtr.Zero;
    private static IntPtr _hOut = IntPtr.Zero;
    private static volatile bool _closing = false;
    private static Thread _pumpThread;

    private class RxShortEvent { public uint Raw; }
    private class RxLongEvent { public byte[] Bytes; public IntPtr HdrPtr; }
    private class RxDisconnectEvent { public string Reason; }

    public static string NormalizeBaseName(string raw) {
      if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
      string trimmed = raw.Trim();
      string stripped = Regex.Replace(trimmed, @"\\s+(?:MIDI\\s*)?(?:IN|OUT)(?:\\s+\\d+)?$", "", RegexOptions.IgnoreCase).Trim();
      return stripped.Length > 0 ? stripped : trimmed;
    }

    private static string EscapeJson(string s) {
      if (s == null) return "";
      var sb = new StringBuilder(s.Length + 8);
      foreach (char c in s) {
        switch (c) {
          case '\\\\': sb.Append("\\\\\\\\"); break;
          case '"': sb.Append("\\\\\\""); break;
          case '\\n': sb.Append("\\\\n"); break;
          case '\\r': sb.Append("\\\\r"); break;
          case '\\t': sb.Append("\\\\t"); break;
          default:
            if (c < ' ') {
              sb.AppendFormat("\\\\u{0:x4}", (int)c);
            } else {
              sb.Append(c);
            }
            break;
        }
      }
      return sb.ToString();
    }

    private static void WriteLineJson(string json) {
      lock (_stdoutLock) {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
      }
    }

    private static string BytesToJsonArray(IReadOnlyList<int> bytes) {
      var sb = new StringBuilder();
      sb.Append('[');
      for (int i = 0; i < bytes.Count; i++) {
        if (i > 0) sb.Append(',');
        sb.Append(bytes[i]);
      }
      sb.Append(']');
      return sb.ToString();
    }

    public static string ListPortsJson() {
      uint outCount = NativeMethods.midiOutGetNumDevs();
      uint inCount = NativeMethods.midiInGetNumDevs();
      var sb = new StringBuilder();
      sb.Append("{\\"in\\":[");
      bool firstIn = true;
      for (uint i = 0; i < inCount; i++) {
        MIDIINCAPSW caps;
        if (NativeMethods.midiInGetDevCapsW((UIntPtr)i, out caps, (uint)Marshal.SizeOf(typeof(MIDIINCAPSW))) == 0) {
          if (!firstIn) sb.Append(',');
          firstIn = false;
          sb.Append('"').Append(EscapeJson(caps.szPname ?? "")).Append('"');
        }
      }
      sb.Append("],\\"out\\":[");
      bool firstOut = true;
      for (uint i = 0; i < outCount; i++) {
        MIDIOUTCAPSW caps;
        if (NativeMethods.midiOutGetDevCapsW((UIntPtr)i, out caps, (uint)Marshal.SizeOf(typeof(MIDIOUTCAPSW))) == 0) {
          if (!firstOut) sb.Append(',');
          firstOut = false;
          sb.Append('"').Append(EscapeJson(caps.szPname ?? "")).Append('"');
        }
      }
      sb.Append("]}");
      return sb.ToString();
    }

    private static void OnMidiInCallback(IntPtr hMidiIn, uint wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2) {
      if (wMsg == NativeMethods.MIM_DATA) {
        _rxQueue.Enqueue(new RxShortEvent { Raw = (uint)dwParam1.ToInt64() });
        _rxEvent.Set();
      } else if (wMsg == NativeMethods.MIM_LONGDATA) {
        if (dwParam1 != IntPtr.Zero) {
          MIDIHDR hdr = (MIDIHDR)Marshal.PtrToStructure(dwParam1, typeof(MIDIHDR));
          byte[] data = new byte[0];
          if (hdr.dwBytesRecorded > 0 && hdr.lpData != IntPtr.Zero) {
            data = new byte[hdr.dwBytesRecorded];
            Marshal.Copy(hdr.lpData, data, 0, (int)hdr.dwBytesRecorded);
          }
          _rxQueue.Enqueue(new RxLongEvent { Bytes = data, HdrPtr = dwParam1 });
          _rxEvent.Set();
        }
      } else if (wMsg == NativeMethods.MIM_LONGERROR) {
        if (dwParam1 != IntPtr.Zero) {
          _rxQueue.Enqueue(new RxLongEvent { Bytes = new byte[0], HdrPtr = dwParam1 });
          _rxEvent.Set();
        }
      } else if (wMsg == NativeMethods.MIM_CLOSE) {
        _rxQueue.Enqueue(new RxDisconnectEvent { Reason = "MIM_CLOSE" });
        _rxEvent.Set();
      }
    }

    private static void RxPumpLoop() {
      var sysexAcc = new List<int>();
      while (!_closing || !_rxQueue.IsEmpty) {
        object item;
        if (_rxQueue.TryDequeue(out item)) {
          var shortEvt = item as RxShortEvent;
          if (shortEvt != null) {
            uint raw = shortEvt.Raw;
            int status = (int)(raw & 0xFF);
            int d1 = (int)((raw >> 8) & 0xFF);
            int d2 = (int)((raw >> 16) & 0xFF);
            int hi = status & 0xF0;
            int[] msg = (hi == 0xC0 || hi == 0xD0) ? new int[] { status, d1 } : new int[] { status, d1, d2 };
            WriteLineJson("{\\"event\\":\\"midi_in\\",\\"bytes\\":" + BytesToJsonArray(msg) + "}");
            continue;
          }

          var longEvt = item as RxLongEvent;
          if (longEvt != null) {
            if (longEvt.Bytes != null && longEvt.Bytes.Length > 0) {
              for (int i = 0; i < longEvt.Bytes.Length; i++) {
                byte b = longEvt.Bytes[i];
                if (b == 0xF0) {
                  sysexAcc.Clear();
                  sysexAcc.Add(b);
                } else if (sysexAcc.Count > 0) {
                  if (sysexAcc.Count >= 65536) {
                    sysexAcc.Clear();
                    continue;
                  }
                  sysexAcc.Add(b);
                  if (b == 0xF7) {
                    WriteLineJson("{\\"event\\":\\"midi_in\\",\\"bytes\\":" + BytesToJsonArray(sysexAcc) + "}");
                    sysexAcc.Clear();
                  }
                }
              }
            }
            if (!_closing && _hIn != IntPtr.Zero && longEvt.HdrPtr != IntPtr.Zero) {
              NativeMethods.midiInAddBuffer(_hIn, longEvt.HdrPtr, (uint)Marshal.SizeOf(typeof(MIDIHDR)));
            }
            continue;
          }

          var discEvt = item as RxDisconnectEvent;
          if (discEvt != null && !_closing) {
            WriteLineJson("{\\"event\\":\\"disconnect\\",\\"reason\\":\\"" + EscapeJson(discEvt.Reason) + "\\"}");
          }
        } else {
          if (_closing) break;
          _rxEvent.WaitOne(50);
        }
      }
    }

    public static void RunWorker(string targetName) {
      string reqLower = (targetName ?? "").Trim().ToLowerInvariant();
      string reqBaseLower = NormalizeBaseName(targetName ?? "").ToLowerInvariant();

      int outId = -1;
      string actualOutRawName = null;
      uint outCount = NativeMethods.midiOutGetNumDevs();
      for (uint i = 0; i < outCount; i++) {
        MIDIOUTCAPSW caps;
        if (NativeMethods.midiOutGetDevCapsW((UIntPtr)i, out caps, (uint)Marshal.SizeOf(typeof(MIDIOUTCAPSW))) == 0) {
          string rawName = (caps.szPname ?? "").Trim();
          string rawLower = rawName.ToLowerInvariant();
          string baseLower = NormalizeBaseName(rawName).ToLowerInvariant();
          if (rawLower == reqLower || baseLower == reqBaseLower || baseLower == reqLower) {
            outId = (int)i;
            actualOutRawName = rawName;
            break;
          }
        }
      }

      int inId = -1;
      string actualInRawName = null;
      uint inCount = NativeMethods.midiInGetNumDevs();
      for (uint i = 0; i < inCount; i++) {
        MIDIINCAPSW caps;
        if (NativeMethods.midiInGetDevCapsW((UIntPtr)i, out caps, (uint)Marshal.SizeOf(typeof(MIDIINCAPSW))) == 0) {
          string rawName = (caps.szPname ?? "").Trim();
          string rawLower = rawName.ToLowerInvariant();
          string baseLower = NormalizeBaseName(rawName).ToLowerInvariant();
          if (rawLower == reqLower || baseLower == reqBaseLower || baseLower == reqLower) {
            inId = (int)i;
            actualInRawName = rawName;
            break;
          }
        }
      }

      if (outId < 0) {
        WriteLineJson("{\\"event\\":\\"open_error\\",\\"code\\":\\"DEVICE_NOT_FOUND\\",\\"mmresult\\":2}");
        return;
      }

      uint resOut = NativeMethods.midiOutOpen(out _hOut, (uint)outId, IntPtr.Zero, IntPtr.Zero, 0);
      if (resOut != 0) {
        string code = resOut == 4 ? "PORT_BUSY" : "DEVICE_NOT_FOUND";
        WriteLineJson("{\\"event\\":\\"open_error\\",\\"code\\":\\"" + code + "\\",\\"mmresult\\":" + resOut + "}");
        return;
      }

      bool inOpened = false;
      int inBuffersPrepared = 0;
      uint inPrepError = 0;
      uint inStartRes = 0;
      _callbackDelegate = OnMidiInCallback;
      if (inId >= 0) {
        uint resIn = NativeMethods.midiInOpen(out _hIn, (uint)inId, _callbackDelegate, IntPtr.Zero, NativeMethods.CALLBACK_FUNCTION);
        if (resIn == 0) {
          uint hdrSize = (uint)Marshal.SizeOf(typeof(MIDIHDR));
          for (int k = 0; k < SYSEX_BUFFER_COUNT; k++) {
            IntPtr bufPtr = Marshal.AllocHGlobal((int)SYSEX_BUFFER_SIZE);
            var hdr = new MIDIHDR {
              lpData = bufPtr,
              dwBufferLength = SYSEX_BUFFER_SIZE,
              dwBytesRecorded = 0,
              dwUser = IntPtr.Zero,
              dwFlags = 0,
              lpNext = IntPtr.Zero,
              reserved = IntPtr.Zero,
              dwOffset = 0,
              reservedArray = new IntPtr[8]
            };
            IntPtr hdrPtr = Marshal.AllocHGlobal((int)hdrSize);
            Marshal.StructureToPtr(hdr, hdrPtr, false);
            uint rPrep = NativeMethods.midiInPrepareHeader(_hIn, hdrPtr, hdrSize);
            uint rAdd = rPrep == 0 ? NativeMethods.midiInAddBuffer(_hIn, hdrPtr, hdrSize) : rPrep;
            if (rPrep == 0 && rAdd == 0) {
              _inHeaders.Add(hdrPtr);
              _inBuffers.Add(bufPtr);
              inBuffersPrepared++;
            } else {
              inPrepError = rPrep != 0 ? rPrep : rAdd;
              if (rPrep == 0) {
                NativeMethods.midiInUnprepareHeader(_hIn, hdrPtr, hdrSize);
              }
              Marshal.FreeHGlobal(hdrPtr);
              Marshal.FreeHGlobal(bufPtr);
            }
          }

          inStartRes = NativeMethods.midiInStart(_hIn);
          inOpened = true;
        } else {
          NativeMethods.midiOutClose(_hOut);
          _hOut = IntPtr.Zero;
          string inErrCode = resIn == 4 ? "PORT_BUSY" : "DEVICE_NOT_FOUND";
          WriteLineJson("{\\"event\\":\\"open_error\\",\\"code\\":\\"" + inErrCode + "\\",\\"op\\":\\"midiInOpen\\",\\"mmresult\\":" + resIn + "}");
          return;
        }
      }

      _pumpThread = new Thread(RxPumpLoop);
      _pumpThread.IsBackground = true;
      _pumpThread.Start();

      string reportedName = NormalizeBaseName(actualOutRawName ?? actualInRawName ?? targetName);
      WriteLineJson(
        "{\\"event\\":\\"opened\\",\\"portName\\":\\"" + EscapeJson(reportedName) +
        "\\",\\"outPortName\\":\\"" + EscapeJson(actualOutRawName ?? "") +
        "\\",\\"inPortName\\":\\"" + EscapeJson(actualInRawName ?? "") +
        "\\",\\"inOpened\\":" + (inOpened ? "true" : "false") +
        ",\\"inBuffers\\":" + inBuffersPrepared +
        ",\\"inPrepError\\":" + inPrepError +
        ",\\"inStartRes\\":" + inStartRes + "}"
      );

      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line.Length == 0) continue;

        if (line.Contains("\\"cmd\\":\\"close\\"")) {
          break;
        }

        var idMatch = Regex.Match(line, "\\"id\\":(\\\\d+)");
        if (!idMatch.Success) continue;
        long reqId = long.Parse(idMatch.Groups[1].Value, CultureInfo.InvariantCulture);

        var bytesMatch = Regex.Match(line, "\\"bytes\\":\\\\[([^\\\\]]*)\\\\]");
        if (!bytesMatch.Success) {
          WriteLineJson("{\\"event\\":\\"ack\\",\\"id\\":" + reqId + ",\\"ok\\":true}");
          continue;
        }

        string rawBytes = bytesMatch.Groups[1].Value.Trim();
        if (rawBytes.Length == 0) {
          WriteLineJson("{\\"event\\":\\"ack\\",\\"id\\":" + reqId + ",\\"ok\\":true}");
          continue;
        }

        string[] parts = rawBytes.Split(',');
        byte[] msg = new byte[parts.Length];
        bool parseOk = true;
        for (int i = 0; i < parts.Length; i++) {
          int parsedByte;
          if (!int.TryParse(parts[i].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedByte)) {
            parseOk = false;
            break;
          }
          msg[i] = (byte)(parsedByte & 0xFF);
        }
        if (!parseOk) {
          WriteLineJson("{\\"event\\":\\"ack\\",\\"id\\":" + reqId + ",\\"ok\\":false,\\"op\\":\\"parse\\",\\"mmresult\\":11}");
          continue;
        }

        uint mmResult;
        string op = "midiOutShortMsg";
        bool mhdrDoneTimeout = false;
        if (msg.Length > 3 || msg[0] == 0xF0) {
          op = "midiOutPrepareHeader";
          uint hdrSize = (uint)Marshal.SizeOf(typeof(MIDIHDR));
          IntPtr bufPtr = Marshal.AllocHGlobal(msg.Length);
          Marshal.Copy(msg, 0, bufPtr, msg.Length);
          var hdr = new MIDIHDR {
            lpData = bufPtr,
            dwBufferLength = (uint)msg.Length,
            dwBytesRecorded = (uint)msg.Length,
            dwUser = IntPtr.Zero,
            dwFlags = 0,
            lpNext = IntPtr.Zero,
            reserved = IntPtr.Zero,
            dwOffset = 0,
            reservedArray = new IntPtr[8]
          };
          IntPtr hdrPtr = Marshal.AllocHGlobal((int)hdrSize);
          Marshal.StructureToPtr(hdr, hdrPtr, false);
          mmResult = NativeMethods.midiOutPrepareHeader(_hOut, hdrPtr, hdrSize);
          if (mmResult == 0) {
            op = "midiOutLongMsg";
            mmResult = NativeMethods.midiOutLongMsg(_hOut, hdrPtr, hdrSize);
            if (mmResult == 0) {
              var startWait = DateTime.UtcNow;
              while ((DateTime.UtcNow - startWait).TotalMilliseconds < 500) {
                MIDIHDR cur = (MIDIHDR)Marshal.PtrToStructure(hdrPtr, typeof(MIDIHDR));
                if ((cur.dwFlags & NativeMethods.MHDR_DONE) != 0) break;
                Thread.Sleep(1);
              }
              MIDIHDR finalHdr = (MIDIHDR)Marshal.PtrToStructure(hdrPtr, typeof(MIDIHDR));
              if ((finalHdr.dwFlags & NativeMethods.MHDR_DONE) == 0) {
                mhdrDoneTimeout = true;
                NativeMethods.midiOutReset(_hOut);
              }
            }
            NativeMethods.midiOutUnprepareHeader(_hOut, hdrPtr, hdrSize);
          }
          Marshal.FreeHGlobal(hdrPtr);
          Marshal.FreeHGlobal(bufPtr);
        } else {
          uint status = msg[0];
          uint d1 = msg.Length > 1 ? msg[1] : 0u;
          uint d2 = msg.Length > 2 ? msg[2] : 0u;
          uint dwMsg = status | (d1 << 8) | (d2 << 16);
          mmResult = NativeMethods.midiOutShortMsg(_hOut, dwMsg);
        }

        if (mmResult == 0) {
          WriteLineJson("{\\"event\\":\\"ack\\",\\"id\\":" + reqId + ",\\"ok\\":true,\\"op\\":\\"" + op + "\\",\\"mhdrDoneTimeout\\":" + (mhdrDoneTimeout ? "true" : "false") + "}");
        } else {
          WriteLineJson("{\\"event\\":\\"ack\\",\\"id\\":" + reqId + ",\\"ok\\":false,\\"op\\":\\"" + op + "\\",\\"mmresult\\":" + mmResult + "}");
        }
      }

      _closing = true;
      _rxEvent.Set();

      if (inOpened && _hIn != IntPtr.Zero) {
        NativeMethods.midiInStop(_hIn);
        NativeMethods.midiInReset(_hIn);
      }

      if (_pumpThread != null && _pumpThread.IsAlive) {
        _pumpThread.Join(500);
      }

      if (inOpened && _hIn != IntPtr.Zero) {
        uint hdrSize = (uint)Marshal.SizeOf(typeof(MIDIHDR));
        foreach (IntPtr hdrPtr in _inHeaders) {
          NativeMethods.midiInUnprepareHeader(_hIn, hdrPtr, hdrSize);
          Marshal.FreeHGlobal(hdrPtr);
        }
        foreach (IntPtr bufPtr in _inBuffers) {
          Marshal.FreeHGlobal(bufPtr);
        }
        _inHeaders.Clear();
        _inBuffers.Clear();
        NativeMethods.midiInClose(_hIn);
        _hIn = IntPtr.Zero;
      }

      if (_hOut != IntPtr.Zero) {
        NativeMethods.midiOutReset(_hOut);
        NativeMethods.midiOutClose(_hOut);
        _hOut = IntPtr.Zero;
      }

      WriteLineJson("{\\"event\\":\\"closed\\"}");
    }
  }
}
`.trim();

let cachedBridgeDir: string | null = null;
let cachedCsPath: string | null = null;
let cachedDllPath: string | null = null;
let cachedListScriptPath: string | null = null;
let cachedWorkerScriptPath: string | null = null;

function writeBridgeFileAtomicIfMissing(targetPath: string, content: string): void {
  if (fs.existsSync(targetPath)) {
    return;
  }
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    try {
      fs.renameSync(tempPath, targetPath);
    } catch {
      if (!fs.existsSync(targetPath)) {
        throw new Error(`Failed to persist WinMM bridge file: ${targetPath}`);
      }
      fs.rmSync(tempPath, { force: true });
    }
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    if (!fs.existsSync(targetPath)) {
      throw err;
    }
  }
}

function ensureWinMmBridgeFiles(): {
  csPath: string;
  dllPath: string;
  listScriptPath: string;
  workerScriptPath: string;
} {
  if (
    cachedBridgeDir &&
    cachedCsPath &&
    cachedDllPath &&
    cachedListScriptPath &&
    cachedWorkerScriptPath &&
    fs.existsSync(cachedCsPath) &&
    fs.existsSync(cachedListScriptPath) &&
    fs.existsSync(cachedWorkerScriptPath)
  ) {
    return {
      csPath: cachedCsPath,
      dllPath: cachedDllPath,
      listScriptPath: cachedListScriptPath,
      workerScriptPath: cachedWorkerScriptPath,
    };
  }

  const WINMM_BRIDGE_SCRIPT_VERSION = 'v2';
  const hash = createHash('sha256')
    .update(WINMM_CSHARP_SOURCE)
    .update('\n')
    .update(WINMM_BRIDGE_SCRIPT_VERSION)
    .digest('hex')
    .slice(0, 12);
  const bridgeDir = path.join(os.tmpdir(), `quicktone-winmm-${hash}`);
  fs.mkdirSync(bridgeDir, { recursive: true });

  const csPath = path.join(bridgeDir, 'bridge.cs');
  const dllPath = path.join(bridgeDir, 'bridge.dll');
  const listScriptPath = path.join(bridgeDir, 'list-ports.ps1');
  const workerScriptPath = path.join(bridgeDir, 'worker.ps1');

  writeBridgeFileAtomicIfMissing(csPath, WINMM_CSHARP_SOURCE);

  const csLiteral = csPath.replace(/'/g, "''");
  const dllLiteral = dllPath.replace(/'/g, "''");
  const loadAssemblySnippet = [
    `if (Test-Path -LiteralPath '${dllLiteral}') {`,
    `  try {`,
    `    Add-Type -Path '${dllLiteral}'`,
    `  } catch {`,
    `    Add-Type -Path '${csLiteral}'`,
    `  }`,
    `} else {`,
    `  try {`,
    `    Add-Type -Path '${csLiteral}' -OutputAssembly '${dllLiteral}'`,
    `    try {`,
    `      Add-Type -Path '${dllLiteral}'`,
    `    } catch {`,
    `      Add-Type -Path '${csLiteral}'`,
    `    }`,
    `  } catch {`,
    `    if (Test-Path -LiteralPath '${dllLiteral}') {`,
    `      try {`,
    `        Add-Type -Path '${dllLiteral}'`,
    `      } catch {`,
    `        Add-Type -Path '${csLiteral}'`,
    `      }`,
    `    } else {`,
    `      Add-Type -Path '${csLiteral}'`,
    `    }`,
    `  }`,
    `}`,
  ].join('\r\n');

  const listScript = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    loadAssemblySnippet,
    '[QuickToneWinMm.Bridge]::ListPortsJson()',
  ].join('\r\n');

  const workerScript = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    loadAssemblySnippet,
    '[QuickToneWinMm.Bridge]::RunWorker($env:QUICKTONE_MIDI_TARGET)',
  ].join('\r\n');

  writeBridgeFileAtomicIfMissing(listScriptPath, listScript);
  writeBridgeFileAtomicIfMissing(workerScriptPath, workerScript);

  cachedBridgeDir = bridgeDir;
  cachedCsPath = csPath;
  cachedDllPath = dllPath;
  cachedListScriptPath = listScriptPath;
  cachedWorkerScriptPath = workerScriptPath;

  return { csPath, dllPath, listScriptPath, workerScriptPath };
}

export function groupWinMmRawPorts(
  raw: { in: readonly string[]; out: readonly string[] },
  allowSystemSynth = false,
): MidiPortInfo[] {
  const grouped = new Map<
    string,
    { name: string; hasIn: boolean; hasOut: boolean }
  >();

  for (const rawIn of raw.in) {
    const trimmedIn = rawIn.trim();
    if (trimmedIn.length === 0) {
      continue;
    }
    if (!allowSystemSynth && trimmedIn.toLowerCase() === SYSTEM_SYNTH_NAME) {
      continue;
    }
    const baseName = normalizeMidiBasePortName(trimmedIn);
    const key = baseName.toLowerCase();
    const existing = grouped.get(key) ?? { name: baseName, hasIn: false, hasOut: false };
    existing.hasIn = true;
    grouped.set(key, existing);
  }

  for (const rawOut of raw.out) {
    const trimmedOut = rawOut.trim();
    if (trimmedOut.length === 0) {
      continue;
    }
    if (!allowSystemSynth && trimmedOut.toLowerCase() === SYSTEM_SYNTH_NAME) {
      continue;
    }
    const baseName = normalizeMidiBasePortName(trimmedOut);
    const key = baseName.toLowerCase();
    const existing = grouped.get(key) ?? { name: baseName, hasIn: false, hasOut: false };
    existing.hasOut = true;
    grouped.set(key, existing);
  }

  const ports: MidiPortInfo[] = [];
  for (const entry of grouped.values()) {
    const direction: MidiPortInfo['direction'] =
      entry.hasIn && entry.hasOut ? 'duplex' : entry.hasIn ? 'in' : 'out';

    ports.push({
      id: entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: entry.name,
      direction,
      isMg300: isMg300PortName(entry.name),
    });
  }

  return ports.sort((a, b) => {
    const mgDiff = Number(b.isMg300) - Number(a.isMg300);
    if (mgDiff !== 0) {
      return mgDiff;
    }
    const aDuplex = a.direction === 'duplex' ? 1 : 0;
    const bDuplex = b.direction === 'duplex' ? 1 : 0;
    return bDuplex - aDuplex;
  });
}

export class WinMmSendAckError extends Error {
  public readonly mmresult: number | null;
  public readonly op: string;

  constructor(mmresult: number | null, op: string) {
    super(`WinMM send failed (op=${op}, mmresult=${String(mmresult)})`);
    this.name = 'WinMmSendAckError';
    this.mmresult = mmresult;
    this.op = op;
  }
}

const USER_FRIENDLY_SEND_ERROR =
  'Não foi possível enviar o comando para a pedaleira. Verifique o cabo USB ou reconecte a NUX MG-300.';

export class WinMmMidiAdapter implements IMidiAdapter {
  public readonly isMock = false;
  private readonly powershellExecutable: string;
  private readonly powershellArgsBuilder: (scriptPath: string) => string[];
  private readonly allowSystemSynth: boolean;
  private readonly commandTimeoutMs: number;
  private readonly logger: MidiDiagnosticsLogger;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerRl: Interface | null = null;
  private connectedPortName: string | null = null;
  private closingIntentionally = false;
  private openInFlight: Promise<{ portName: string }> | null = null;
  private recoveryInFlight: Promise<boolean> | null = null;
  private nextRequestId = 1;
  private readonly pendingAcks = new Map<
    number,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly incomingListeners = new Set<(bytes: number[]) => void>();
  private readonly disconnectListeners = new Set<(reason?: string) => void>();

  constructor(options: WinMmMidiAdapterOptions = {}) {
    this.powershellExecutable = options.powershellExecutable ?? 'powershell.exe';
    this.powershellArgsBuilder =
      options.powershellArgsBuilder ??
      ((scriptPath) => [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ]);
    this.allowSystemSynth = options.allowSystemSynth ?? false;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 12000;
    this.logger = options.logger ?? getSharedMidiDiagnosticsLogger();
  }

  public async listPorts(): Promise<MidiPortInfo[]> {
    const raw = await this.runListPortsQuery();
    return groupWinMmRawPorts(raw, this.allowSystemSynth);
  }

  public async openPort(portName: string): Promise<{ portName: string }> {
    while (this.openInFlight) {
      await this.openInFlight.catch(() => {});
    }
    const promise = this.performOpenPort(portName).finally(() => {
      if (this.openInFlight === promise) {
        this.openInFlight = null;
      }
    });
    this.openInFlight = promise;
    return promise;
  }

  private async performOpenPort(portName: string): Promise<{ portName: string }> {
    const trimmed = portName.trim();
    if (!this.allowSystemSynth && trimmed.toLowerCase() === SYSTEM_SYNTH_NAME) {
      throw new MidiServiceError(
        'UNVALIDATED_MESSAGE_BLOCKED',
        'Conexão com "Microsoft GS Wavetable Synth" bloqueada por segurança.',
      );
    }

    if (this.worker) {
      await this.closePort();
    }

    return new Promise<{ portName: string }>((resolve, reject) => {
      let openedResolved = false;
      this.closingIntentionally = false;
      const { workerScriptPath } = ensureWinMmBridgeFiles();

      this.logger.info('winmm', 'Opening MIDI port via worker', { targetPort: trimmed });

      const child = spawn(
        this.powershellExecutable,
        this.powershellArgsBuilder(workerScriptPath),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            QUICKTONE_MIDI_TARGET: trimmed,
          },
        },
      );
      this.worker = child;
      child.stdin.on('error', (err) => {
        this.logger.warn('winmm.stdin', 'WinMM worker stdin stream error', {
          targetPort: trimmed,
          pid: child.pid,
          error: err.message,
        });
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString().trim();
        if (text.length > 0) {
          this.logger.warn('winmm.stderr', text, { targetPort: trimmed, pid: child.pid });
        }
      });

      const openTimer = setTimeout(() => {
        if (!openedResolved) {
          openedResolved = true;
          this.logger.error('winmm', 'Timeout opening MIDI port (MidiSrv/driver stalled)', {
            targetPort: trimmed,
            timeoutMs: this.commandTimeoutMs,
            pid: child.pid,
          });
          this.cleanupWorker();
          reject(
            new MidiServiceError(
              'PORT_BUSY',
              'A pedaleira demorou para responder ao conectar. Desconecte e reconecte o cabo USB e tente novamente.',
            ),
          );
        }
      }, this.commandTimeoutMs);

      const rl = createInterface({ input: child.stdout });
      this.workerRl = rl;

      rl.on('line', (line) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        const event = payload.event;
        if (event === 'opened' && !openedResolved) {
          openedResolved = true;
          clearTimeout(openTimer);
          if (this.closingIntentionally || this.worker !== child) {
            try {
              child.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`);
              child.stdin.end();
            } catch {
              // Ignore write error on closing child
            }
            reject(
              new MidiServiceError(
                'DISCONNECTED',
                'A conexão com a pedaleira foi cancelada.',
              ),
            );
            return;
          }
          const actualName =
            typeof payload.portName === 'string' && payload.portName.length > 0
              ? payload.portName
              : normalizeMidiBasePortName(trimmed);
          this.connectedPortName = actualName;
          this.logger.info('winmm', 'MIDI port opened', {
            portName: actualName,
            outPortName: payload.outPortName,
            inPortName: payload.inPortName,
            inOpened: payload.inOpened,
            inBuffers: payload.inBuffers,
            inPrepError: payload.inPrepError,
            inStartRes: payload.inStartRes,
            pid: child.pid,
          });
          if (payload.inOpened === true && payload.inBuffers === 0) {
            this.logger.warn('winmm', 'MIDI IN opened with zero SysEx buffers prepared', {
              inPortName: payload.inPortName,
              inPrepError: payload.inPrepError,
            });
          }
          resolve({ portName: actualName });
        } else if (event === 'open_error' && !openedResolved) {
          openedResolved = true;
          clearTimeout(openTimer);
          const code = payload.code === 'PORT_BUSY' ? 'PORT_BUSY' : 'DEVICE_NOT_FOUND';
          this.logger.error('winmm', 'Failed to open MIDI port', {
            targetPort: trimmed,
            code,
            op: payload.op,
            mmresult: payload.mmresult,
          });
          const msg =
            code === 'PORT_BUSY'
              ? 'A pedaleira está em uso por outro programa (como o QuickTone ou uma DAW). Feche o outro programa e tente conectar novamente.'
              : 'Pedaleira não encontrada. Verifique se a NUX MG-300 está ligada e conectada pelo cabo USB.';
          this.cleanupWorker();
          reject(new MidiServiceError(code, msg));
        } else if (event === 'midi_in' && Array.isArray(payload.bytes)) {
          const bytes = (payload.bytes as unknown[]).filter(
            (b): b is number => typeof b === 'number',
          );
          if (bytes.length > 0 && bytes[0] === 0xf0) {
            this.logger.debug('winmm.rx', 'SysEx received', {
              length: bytes.length,
              hex: formatHexBytes(bytes, 16),
            });
          }
          for (const listener of this.incomingListeners) {
            listener(bytes);
          }
        } else if (event === 'ack' && typeof payload.id === 'number') {
          const pending = this.pendingAcks.get(payload.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingAcks.delete(payload.id);
            if (payload.ok === true) {
              if (payload.mhdrDoneTimeout === true) {
                this.logger.warn('winmm.tx', 'SysEx MHDR_DONE timeout triggered midiOutReset', {
                  reqId: payload.id,
                  op: payload.op,
                });
              }
              pending.resolve();
            } else {
              const mmresult = typeof payload.mmresult === 'number' ? payload.mmresult : null;
              const op = typeof payload.op === 'string' ? payload.op : 'unknown';
              this.logger.error('winmm.tx', 'WinMM send returned error', {
                reqId: payload.id,
                op,
                mmresult,
                portName: this.connectedPortName,
              });
              pending.reject(new WinMmSendAckError(mmresult, op));
            }
          }
        } else if (event === 'disconnect') {
          const reason =
            typeof payload.reason === 'string' ? payload.reason : 'WinMM device closed';
          this.logger.warn('winmm', 'MIDI device disconnected event from worker', { reason });
          this.handleUnexpectedDisconnect(
            'A conexão USB com a pedaleira foi interrompida.',
          );
        }
      });

      child.on('error', (err) => {
        this.logger.error('winmm', 'Worker process error', {
          targetPort: trimmed,
          error: err.message,
        });
        if (!openedResolved) {
          openedResolved = true;
          clearTimeout(openTimer);
          this.cleanupWorker();
          reject(
            new MidiServiceError(
              'DEVICE_NOT_FOUND',
              'Não foi possível iniciar a comunicação com a pedaleira. Tente novamente.',
            ),
          );
        } else if (!this.closingIntentionally) {
          this.handleUnexpectedDisconnect('A comunicação com a pedaleira foi interrompida.');
        }
      });

      child.on('exit', (exitCode, signal) => {
        this.logger.info('winmm', 'Worker process exited', {
          targetPort: trimmed,
          exitCode,
          signal,
          closingIntentionally: this.closingIntentionally,
          openedResolved,
        });
        if (!openedResolved) {
          openedResolved = true;
          clearTimeout(openTimer);
          this.cleanupWorker();
          reject(
            new MidiServiceError(
              'DEVICE_NOT_FOUND',
              'Não foi possível abrir a conexão com a pedaleira. Verifique o cabo USB e tente novamente.',
            ),
          );
        } else if (!this.closingIntentionally && this.connectedPortName !== null) {
          this.handleUnexpectedDisconnect('A conexão com a pedaleira foi perdida inesperadamente.');
        }
      });
    });
  }

  public async closePort(): Promise<void> {
    this.closingIntentionally = true;
    this.connectedPortName = null;
    const activeWorker = this.worker;

    if (activeWorker && !activeWorker.killed && activeWorker.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };

        const timer = setTimeout(finish, 1200);
        activeWorker.once('exit', finish);

        try {
          activeWorker.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`);
          activeWorker.stdin.end();
        } catch {
          finish();
        }
      });
    }

    this.cleanupWorker();
  }

  public isConnected(): boolean {
    return (
      this.recoveryInFlight !== null ||
      (this.connectedPortName !== null && this.worker !== null)
    );
  }

  public getConnectedPortName(): string | null {
    return this.connectedPortName;
  }

  public async sendBytes(bytes: number[]): Promise<void> {
    if (this.recoveryInFlight) {
      await this.recoveryInFlight.catch(() => false);
    }

    if (!this.worker || !this.connectedPortName) {
      throw new MidiServiceError(
        'DISCONNECTED',
        'A pedaleira não está conectada no momento. Conecte a NUX MG-300 e tente novamente.',
      );
    }

    const portAtSend = this.connectedPortName;
    try {
      await this.sendBytesOnce(bytes);
    } catch (err) {
      if (err instanceof WinMmSendAckError && err.mmresult === 1) {
        this.logger.warn(
          'winmm.recovery',
          'Detected WinMM send stall (mmresult=1 / MMSYSERR_ERROR); attempting single clean reconnect',
          {
            portName: portAtSend,
            op: err.op,
            bytesHex: formatHexBytes(bytes, 16),
          },
        );
        const recovered = await this.recoverFromSendStall(portAtSend);
        if (recovered) {
          try {
            await this.sendBytesOnce(bytes);
            this.logger.info('winmm.recovery', 'Resend succeeded after clean WinMM reconnect', {
              portName: portAtSend,
              bytesHex: formatHexBytes(bytes, 16),
            });
            return;
          } catch (retryErr) {
            this.logger.error('winmm.recovery', 'Resend failed even after clean WinMM reconnect', {
              portName: portAtSend,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
              bytesHex: formatHexBytes(bytes, 16),
            });
          }
        }
        await this.forceDisconnectAfterStall(
          'A pedaleira parou de responder. Desconecte e reconecte o cabo USB para restabelecer a comunicação.',
        );
        throw new MidiServiceError('TRANSMISSION_FAILED', USER_FRIENDLY_SEND_ERROR);
      }

      if (err instanceof WinMmSendAckError) {
        this.logger.error('winmm.tx', 'Send failed with non-stall WinMM error', {
          portName: portAtSend,
          op: err.op,
          mmresult: err.mmresult,
          bytesHex: formatHexBytes(bytes, 16),
        });
        throw new MidiServiceError('TRANSMISSION_FAILED', USER_FRIENDLY_SEND_ERROR);
      }

      throw err;
    }
  }

  private async recoverFromSendStall(portName: string): Promise<boolean> {
    if (this.recoveryInFlight) {
      return this.recoveryInFlight;
    }

    const promise = (async (): Promise<boolean> => {
      try {
        await this.closePort();
        await this.openPort(portName);
        this.logger.info('winmm.recovery', 'Clean WinMM reconnect succeeded', { portName });
        return true;
      } catch (err) {
        this.logger.error('winmm.recovery', 'Clean WinMM reconnect failed', {
          portName,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    })().finally(() => {
      if (this.recoveryInFlight === promise) {
        this.recoveryInFlight = null;
      }
    });

    this.recoveryInFlight = promise;
    return promise;
  }

  private async forceDisconnectAfterStall(reason: string): Promise<void> {
    await this.closePort();
    this.closingIntentionally = false;
    for (const listener of this.disconnectListeners) {
      listener(reason);
    }
  }

  private sendBytesOnce(bytes: number[]): Promise<void> {
    if (!this.worker || !this.connectedPortName) {
      return Promise.reject(
        new MidiServiceError(
          'DISCONNECTED',
          'A pedaleira não está conectada no momento. Conecte a NUX MG-300 e tente novamente.',
        ),
      );
    }

    if (bytes.length > 0 && bytes[0] === 0xf0) {
      this.logger.debug('winmm.tx', 'Sending SysEx', {
        length: bytes.length,
        hex: formatHexBytes(bytes, 16),
      });
    }

    const requestId = this.nextRequestId++;
    const activePort = this.connectedPortName;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        this.logger.error('winmm.tx', 'Timeout waiting for WinMM worker send ACK', {
          reqId: requestId,
          portName: activePort,
          timeoutMs: this.commandTimeoutMs,
          bytesHex: formatHexBytes(bytes, 16),
        });
        reject(
          new MidiServiceError(
            'TRANSMISSION_FAILED',
            'A pedaleira demorou para confirmar o comando. Verifique o cabo USB ou tente novamente.',
          ),
        );
      }, this.commandTimeoutMs);

      this.pendingAcks.set(requestId, { resolve, reject, timer });

      try {
        this.worker?.stdin.write(
          `${JSON.stringify({ cmd: 'send', id: requestId, bytes })}\n`,
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(requestId);
        this.logger.error('winmm.tx', 'Failed to write command to WinMM worker stdin', {
          reqId: requestId,
          portName: activePort,
          error: err instanceof Error ? err.message : String(err),
        });
        reject(new MidiServiceError('TRANSMISSION_FAILED', USER_FRIENDLY_SEND_ERROR));
      }
    });
  }

  public onIncomingMessage(listener: (bytes: number[]) => void): () => void {
    this.incomingListeners.add(listener);
    return () => {
      this.incomingListeners.delete(listener);
    };
  }

  public onDisconnect(listener: (reason?: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private handleUnexpectedDisconnect(reason?: string): void {
    if (this.closingIntentionally) {
      return;
    }
    this.cleanupWorker();
    for (const listener of this.disconnectListeners) {
      listener(reason);
    }
  }

  private cleanupWorker(): void {
    this.connectedPortName = null;
    if (this.workerRl) {
      try {
        this.workerRl.close();
      } catch {
        // Ignore close errors
      }
      this.workerRl = null;
    }
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(
        new MidiServiceError('DISCONNECTED', 'Conexão MIDI encerrada durante envio.'),
      );
    }
    this.pendingAcks.clear();

    if (this.worker) {
      const current = this.worker;
      this.worker = null;
      try {
        if (current.stdin.writable) {
          current.stdin.end();
        }
      } catch {
        // Ignore stdin close errors on already terminated child
      }
      if (!current.killed && current.exitCode === null) {
        try {
          current.kill();
        } catch {
          // Ignore kill errors on already terminated child
        }
      }
    }
  }

  private runListPortsQuery(): Promise<{ in: string[]; out: string[] }> {
    return new Promise((resolve) => {
      const { listScriptPath } = ensureWinMmBridgeFiles();
      execFile(
        this.powershellExecutable,
        this.powershellArgsBuilder(listScriptPath),
        { timeout: this.commandTimeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err || !stdout) {
            this.logger.warn('winmm.listPorts', 'Failed to list WinMM MIDI ports', {
              error: err ? err.message : 'empty stdout',
              stderr: stderr ? stderr.trim() : '',
            });
            resolve({ in: [], out: [] });
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim()) as {
              in?: unknown;
              out?: unknown;
            };
            const inList = Array.isArray(parsed.in)
              ? parsed.in.filter((x): x is string => typeof x === 'string')
              : [];
            const outList = Array.isArray(parsed.out)
              ? parsed.out.filter((x): x is string => typeof x === 'string')
              : [];
            this.logger.debug('winmm.listPorts', 'Enumerated WinMM ports', {
              in: inList,
              out: outList,
            });
            resolve({ in: inList, out: outList });
          } catch (parseErr) {
            this.logger.warn('winmm.listPorts', 'Invalid JSON from WinMM port listing', {
              stdout: stdout.trim().slice(0, 200),
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            resolve({ in: [], out: [] });
          }
        },
      );
    });
  }
}
