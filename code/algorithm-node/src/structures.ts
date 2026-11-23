export interface ListNode {
  value: number;
  next: ListNode | null;
}

// Expects an acyclic list and rewires the original nodes.
export function reverseList(head: ListNode | null): ListNode | null {
  let previous: ListNode | null = null;
  let current = head;
  while (current !== null) {
    const next = current.next;
    current.next = previous;
    previous = current;
    current = next;
  }
  return previous;
}

const closing = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

export function bracketsValid(text: string): boolean {
  const stack: string[] = [];
  for (const char of text) {
    const expected = closing.get(char);
    if (expected !== undefined) stack.push(expected);
    else if (stack.pop() !== char) return false;
  }
  return stack.length === 0;
}
