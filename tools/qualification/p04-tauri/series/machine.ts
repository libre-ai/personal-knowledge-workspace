// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The measurement machine (PROTOCOL.md section 6, CA-43), read as
// `tools/qualification/notebook-core-v2/check-resource-class.ts` reads it and
// judged by the same class selection.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type NotebookHardwareResources,
  parseResourceClassManifest,
  selectResourceClass,
} from "../../notebook-core-v2/resource-class";
import type { MachineRecord } from "./manifest";

function command(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed`);
  return result.stdout.toString().trim();
}

/** Throws when the machine is outside `machineClass`: such a machine measures nothing. */
export function detectMachine(repository: string, machineClass: string): MachineRecord {
  const manifest = parseResourceClassManifest(
    JSON.parse(
      readFileSync(join(repository, "toolchains", "notebook-resource-classes.json"), "utf8"),
    ),
  );
  const hardware: NotebookHardwareResources = {
    architecture: process.arch,
    hardwareModel: command(["sysctl", "-n", "hw.model"]),
    hypervisorPresent: command(["sysctl", "-n", "kern.hv_vmm_present"]) !== "0",
    logicalCpu: Number(command(["sysctl", "-n", "hw.logicalcpu"])),
    memoryBytes: Number(command(["sysctl", "-n", "hw.memsize"])),
    operatingSystem: process.platform,
    processor: command(["sysctl", "-n", "machdep.cpu.brand_string"]),
  };
  if (hardware.hypervisorPresent)
    throw new Error("machine: a virtual machine is not a measurement machine");
  const selected = selectResourceClass(manifest, machineClass, hardware);
  return {
    class: selected.id,
    operatingSystem: hardware.operatingSystem,
    architecture: hardware.architecture,
    hardwareModel: hardware.hardwareModel,
    processor: hardware.processor,
    memoryBytes: hardware.memoryBytes,
    logicalCpu: hardware.logicalCpu,
    hypervisorPresent: hardware.hypervisorPresent,
    osVersion: command(["sw_vers", "-productVersion"]),
  };
}
