export function analyzeExperimentEvents(events: Array<Record<string, any>>): Record<string, any>;
export function verifySyntheticTasks(tasks: Array<Record<string, any>>): { task_count: number; task_ids: string[] };
export function verifyE6ParallelForms(forms: Array<Record<string, any>>): { form_count: number; presentation_ids: string[] };
