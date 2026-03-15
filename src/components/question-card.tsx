"use client";

import { useMemo, useState, useCallback } from "react";
import { MessageCircleQuestion, Check, Circle, CircleDot } from "lucide-react";
import type { ToolUse } from "@/types";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

function parseQuestions(input: string): Question[] {
  try {
    const parsed = JSON.parse(input);
    return (parsed.questions as Question[]) || [];
  } catch {
    return [];
  }
}

function parseAnswer(output: string): Map<string, string> {
  const answers = new Map<string, string>();
  const re = /"([^"]+)"="([^"]+)"/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    answers.set(match[1], match[2]);
  }
  return answers;
}

// Read-only questions in the message history
export function QuestionCard({ tool }: { tool: ToolUse }) {
  const questions = useMemo(() => parseQuestions(tool.input), [tool.input]);
  const answers = useMemo(() => parseAnswer(tool.output || ""), [tool.output]);

  if (questions.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-background/50 p-3 space-y-3">
      {questions.map((q, qi) => {
        const selected = answers.get(q.question);
        return (
          <div key={qi} className="space-y-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <MessageCircleQuestion className="h-4 w-4 shrink-0 text-muted-foreground" />
              {q.question}
            </div>
            <div className="space-y-0.5 pl-6">
              {q.options.map((opt, oi) => {
                const isSelected = selected === opt.label;
                return (
                  <div
                    key={oi}
                    className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-xs ${
                      isSelected ? "bg-primary/10" : ""
                    }`}
                  >
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/40" />
                    )}
                    <div className="min-w-0">
                      <div className={isSelected ? "font-medium text-foreground" : "text-muted-foreground"}>
                        {opt.label}
                      </div>
                      {isSelected && opt.description && (
                        <div className="text-muted-foreground text-[11px] mt-0.5">{opt.description}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Interactive version rendered standalone in the chat flow
interface QuestionPromptProps {
  questions: Question[];
  requestId: string;
  onSubmit: (requestId: string, answers: Record<string, string>) => void;
}

export function QuestionPrompt({ questions, requestId, onSubmit }: QuestionPromptProps) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const toggleSelection = useCallback((questionText: string, label: string) => {
    if (submitted) return;
    setSelections((prev) => ({
      ...prev,
      [questionText]: prev[questionText] === label ? "" : label,
    }));
  }, [submitted]);

  const allAnswered = questions.every((q) => selections[q.question]);

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);
    onSubmit(requestId, selections);
  }, [allAnswered, submitted, requestId, selections, onSubmit]);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="space-y-3">
        {questions.map((q, qi) => {
          const selected = selections[q.question];
          return (
            <div key={qi} className="space-y-2">
              {q.header && (
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{q.header}</div>
              )}
              <div className="text-sm font-medium flex items-center gap-2">
                <MessageCircleQuestion className="h-4 w-4 shrink-0 text-muted-foreground" />
                {q.question}
              </div>
              <div className="space-y-0.5 pl-6">
                {q.options.map((opt, oi) => {
                  const isSelected = selected === opt.label;
                  const El = submitted ? "div" : "button";
                  return (
                    <El
                      key={oi}
                      onClick={submitted ? undefined : () => toggleSelection(q.question, opt.label)}
                      className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-xs text-left transition-colors ${
                        isSelected
                          ? "bg-primary/10"
                          : submitted
                            ? ""
                            : "hover:bg-muted/50 cursor-pointer"
                      }`}
                    >
                      {isSelected ? (
                        <Check className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/40" />
                      )}
                      <div className="min-w-0">
                        <div className={isSelected ? "font-medium text-foreground" : submitted ? "text-muted-foreground" : "text-foreground"}>
                          {opt.label}
                        </div>
                        {opt.description && (
                          <div className="text-muted-foreground text-[11px] mt-0.5">{opt.description}</div>
                        )}
                      </div>
                    </El>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!submitted && (
          <div className="flex justify-end pt-1">
            <button
              disabled={!allAnswered}
              onClick={handleSubmit}
              className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
                allAnswered
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              }`}
            >
              Submit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Helper to parse questions from raw JSON string
export function parseQuestionsFromInput(input: string): Question[] {
  return parseQuestions(input);
}
