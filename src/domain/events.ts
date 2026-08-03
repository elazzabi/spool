export interface InterventionEvent {
  id: string;
  jobId: string;
  eventKey: string;
  prompt: string;
  createdAt: string;
  closedAt: string | null;
  response: string | null;
}

export interface FollowUpAction {
  id: string;
  jobId: string;
  eventKey: string;
  text: string;
  createdAt: string;
  completedAt: string | null;
}
