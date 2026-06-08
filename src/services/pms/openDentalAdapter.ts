/**
 * Open Dental PMS adapter — bridges the Voice AI to Open Dental's API.
 *
 * Open Dental v24+ exposes a REST API at https://<host>:<port>/api/v1/.
 * This adapter implements the PmsAdapter interface and translates
 * Voice AI domain types into Open Dental API calls.
 *
 * Auth: API key via the Authorization header.
 */

import {
  type PmsAdapter,
  type PmsProvider,
  type PmsPagination,
  type PmsSlotQuery,
  type PmsCreateAppointmentInput,
  type PmsPatientLookup,
} from "./types.js";
import type { ClinicId, PatientId, AppointmentId } from "../../types/call.js";
import type {
  Patient,
  Appointment,
  AppointmentSlot,
} from "../../types/dental.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── Open Dental API types ────────────────────────────────────────

interface OdPatient {
  PatNum: number;
  FName: string;
  LName: string;
  Birthdate: string;
  HmPhone: string;
  WkPhone: string;
  WirelessPhone: string;
  Email: string;
  ChartNumber: string;
  PreferConfirmMethod: number;
  PreferContactMethod: number;
  DateFirstVisit: string;
}

interface OdAppointment {
  AptNum: number;
  PatNum: number;
  ProvNum: number;
  ClinicNum: number;
  OpNum: number;
  AptDateTime: string;
  NextAptNum: number;
  Confirmed: number;
  IsNewPatient: string;
  Note: string;
  AppointmentTypeNum: number;
  Pattern: string;
  TimeLocked: boolean;
}

interface OdScheduleSlot {
  ProvNum: number;
  OpNum: number;
  DateTime: string;
  ProvName: string;
  OpName: string;
  IsAvailable: boolean;
}

interface OdApiList<T> {
  items: T[];
  totalCount: number;
}

// ── Adapter ──────────────────────────────────────────────────────

export class OpenDentalAdapter implements PmsAdapter {
  readonly provider: PmsProvider = "open_dental";

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  // ── Health ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.fetch("/api/v1/appointments?Limit=1");
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ── Patients ──────────────────────────────────────────────────

  async findPatients(
    lookup: PmsPatientLookup,
    pagination: PmsPagination,
  ): Promise<Patient[]> {
    const params = new URLSearchParams();
    if (lookup.firstName) params.set("FName", lookup.firstName);
    if (lookup.lastName) params.set("LName", lookup.lastName);
    if (lookup.phone) params.set("PhoneNumber", lookup.phone);
    if (lookup.dateOfBirth) params.set("Birthdate", lookup.dateOfBirth);
    params.set("Limit", String(pagination.limit));
    params.set("Offset", String(pagination.offset));

    const resp = await this.fetch(`/api/v1/patients?${params.toString()}`);
    if (!resp.ok) return [];

    const data = (await resp.json()) as OdApiList<OdPatient>;
    return data.items.map((p) => this.toPatient(lookup.clinicId, p));
  }

  async getPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<Patient | null> {
    const resp = await this.fetch(`/api/v1/patients/${patientId}`);
    if (!resp.ok) return null;
    const p = (await resp.json()) as OdPatient;
    return this.toPatient(clinicId, p);
  }

  async upsertPatient(patient: Patient): Promise<Patient> {
    const body = this.toOdPatient(patient);
    const resp = await this.fetch("/api/v1/patients", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Open Dental upsert failed: ${resp.status}`);
    }
    const p = (await resp.json()) as OdPatient;
    return this.toPatient(patient.clinicId, p);
  }

  // ── Appointments ──────────────────────────────────────────────

  async getAvailableSlots(query: PmsSlotQuery): Promise<AppointmentSlot[]> {
    const params = new URLSearchParams();
    params.set("DateStart", query.startDate);
    params.set("DateEnd", query.endDate);
    if (query.providerId) params.set("ProvNum", query.providerId);
    params.set("AppointmentTypeNum", this.mapAppointmentType(query.appointmentType));

    // Open Dental's schedule endpoint returns available time blocks.
    const resp = await this.fetch(`/api/v1/schedule/slots?${params.toString()}`);
    if (!resp.ok) return [];

    const data = (await resp.json()) as OdApiList<OdScheduleSlot>;
    return data.items.map((s) => ({
      date: s.DateTime.slice(0, 10),
      startTime: s.DateTime.slice(11, 16),
      endTime: this.addMinutes(s.DateTime.slice(11, 16), query.durationMinutes),
      providerId: String(s.ProvNum),
      operatoryId: String(s.OpNum),
      isAvailable: s.IsAvailable,
    }));
  }

  async createAppointment(
    input: PmsCreateAppointmentInput,
  ): Promise<Appointment> {
    const body = {
      PatNum: Number(input.patientId),
      ProvNum: Number(input.providerId),
      OpNum: Number(input.operatoryId),
      AptDateTime: input.startTime,
      Note: `${input.reason ?? ""}\n${input.notes ?? ""}`.trim(),
      Confirmed: 1,
      AppointmentTypeNum: this.mapAppointmentType(input.type),
    };

    const resp = await this.fetch("/api/v1/appointments", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Open Dental create appointment failed: ${resp.status}`);
    }
    const a = (await resp.json()) as OdAppointment;
    return this.toAppointment(input.clinicId, input.patientId, a);
  }

  async cancelAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<void> {
    await this.fetch(`/api/v1/appointments/${appointmentId}`, {
      method: "PUT",
      body: JSON.stringify({ AptStatus: 5 }), // 5 = cancelled in Open Dental
    });
    safeLog("info", "Appointment cancelled in PMS", {
      callId: clinicId,
      context: { appointmentId: appointmentId },
    });
  }

  async getAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<Appointment | null> {
    const resp = await this.fetch(`/api/v1/appointments/${appointmentId}`);
    if (!resp.ok) return null;
    const a = (await resp.json()) as OdAppointment;
    return this.toAppointment(
      clinicId,
      String(a.PatNum) as PatientId,
      a,
    );
  }

  // ── Internal helpers ──────────────────────────────────────────

  private async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `ODAPI ${this.apiKey}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }

  private toPatient(clinicId: ClinicId, p: OdPatient): Patient {
    return {
      patientId: String(p.PatNum) as PatientId,
      clinicId,
      firstName: p.FName,
      lastName: p.LName,
      dateOfBirth: p.Birthdate,
      phoneNumbers: [p.HmPhone, p.WkPhone, p.WirelessPhone].filter(Boolean),
      email: p.Email || null,
      insurance: null,
      chartNumber: p.ChartNumber || null,
      preferredLanguage: "en",
      lastVisitAt: p.DateFirstVisit ? new Date(p.DateFirstVisit) : null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private toOdPatient(p: Patient): Record<string, unknown> {
    return {
      FName: p.firstName,
      LName: p.lastName,
      Birthdate: p.dateOfBirth,
      HmPhone: p.phoneNumbers[0] ?? "",
      ChartNumber: p.chartNumber ?? "",
    };
  }

  private toAppointment(
    clinicId: ClinicId,
    patientId: PatientId,
    a: OdAppointment,
  ): Appointment {
    return {
      appointmentId: String(a.AptNum) as AppointmentId,
      clinicId,
      patientId,
      providerId: String(a.ProvNum),
      operatoryId: String(a.OpNum),
      type: "consultation",
      status: a.Confirmed === 1 ? "confirmed" : "scheduled",
      scheduledStart: new Date(a.AptDateTime),
      scheduledEnd: new Date(a.AptDateTime),
      durationMinutes: 60,
      reason: a.Note,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private mapAppointmentType(type: string): string {
    // Open Dental uses numeric AppointmentTypeNum.
    // This maps our string types to common Open Dental type numbers.
    // Production would query the /api/v1/definition?Category=1 endpoint.
    const map: Record<string, string> = {
      emergency: "1",
      new_patient_exam: "2",
      recall_exam: "3",
      cleaning: "4",
      filling: "5",
      crown: "6",
      root_canal: "7",
      extraction: "8",
      consultation: "9",
      follow_up: "10",
    };
    return map[type] ?? "9";
  }

  private addMinutes(time: string, minutes: number): string {
    const [h, m] = time.split(":").map(Number) as [number, number];
    const total = h * 60 + m + minutes;
    const nh = Math.floor(total / 60) % 24;
    const nm = total % 60;
    return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
  }
}
