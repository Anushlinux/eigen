export interface ExternalJobConfig {
  default_trials?: number;
  timeout_ms?: number;
  application: { id: string; contentHash: string };
  model: string | null;
  environment: "simulation";
  suites: Array<{
    id: string;
    name: string;
    scenarios: Array<{ id: string; name: string }>;
  }>;
  available: boolean;
  unavailable_reason?: string | undefined;
}

export interface ExternalJob {
  id: string;
  submission_id: string;
  suite_id: string;
  trials: number;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    completed: number;
    total: number;
    scenario_id?: string | undefined;
    trial?: number | undefined;
  };
  created_at: string;
  updated_at: string;
  result_suite_id?: string | undefined;
  decision?: "allow" | "block" | undefined;
  error?: { code: string; message: string } | undefined;
}

export interface ExternalSelection {
  suiteId: string;
  scenarioId?: string | undefined;
  trial?: number | undefined;
}
