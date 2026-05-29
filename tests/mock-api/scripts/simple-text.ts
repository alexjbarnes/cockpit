import { textResponse } from "../builder";
import type { TurnScript } from "../types";

export const simpleTextScript: TurnScript[] = [{ events: textResponse("Hello! I'm a mock Claude assistant running in e2e test mode.") }];
