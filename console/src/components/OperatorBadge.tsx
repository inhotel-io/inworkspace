import { currentOperator } from "@/lib/operator";

export async function OperatorBadge() {
  const operator = await currentOperator();
  return operator ? <span title="Signed in through the identity-aware proxy">{operator.email}</span> : null;
}
