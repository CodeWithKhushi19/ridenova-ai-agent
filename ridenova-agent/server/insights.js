import { daysBetween } from './util.js';

export async function buildInsights(repo, today) {
  const [pending, tickets] = await Promise.all([repo.listPendingBookings(), repo.listOpenTickets()]);
  const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const pb = pending.map((b) => {
    const flags = [];
    const ageDays = b.bookingDate ? daysBetween(b.bookingDate, today) : null;
    if (ageDays != null && ageDays >= 3) flags.push(`Waiting ${ageDays} days`);
    if (b.pickupDate && daysBetween(today, b.pickupDate) <= 3) flags.push(`Pickup in ${Math.max(0, daysBetween(today, b.pickupDate))} day(s)`);
    return { ref: b.ref, customer: b.customerName, vehicle: b.vehicleName, pickupDate: b.pickupDate, returnDate: b.returnDate, totalRent: b.totalRent, ageDays, flags };
  });
  const tk = tickets.map((t) => {
    const ageDays = t.ticketDate ? daysBetween(t.ticketDate, today) : null;
    const flags = [];
    if (['Critical', 'High'].includes(t.priority) && t.status === 'Open') flags.push('Urgent & unassigned');
    if (ageDays != null && ageDays >= 3) flags.push(`Open ${ageDays} days`);
    return { ref: t.ref, customer: t.customerName, booking: t.bookingRef, issueType: t.issueType, priority: t.priority, status: t.status, assignedTo: t.assignedTo, ageDays, flags };
  }).sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0));
  const byPriority = {}; const byIssue = {};
  for (const t of tk) { byPriority[t.priority] = (byPriority[t.priority] || 0) + 1; byIssue[t.issueType] = (byIssue[t.issueType] || 0) + 1; }
  return {
    generatedAt: new Date().toISOString(), today,
    totals: { pendingBookings: pb.length, pendingRent: pb.reduce((s, b) => s + (b.totalRent || 0), 0), openTickets: tk.length,
      urgentTickets: tk.filter((t) => ['Critical', 'High'].includes(t.priority)).length, needAttention: pb.filter((b) => b.flags.length).length + tk.filter((t) => t.flags.length).length },
    pendingBookings: pb, openTickets: tk, ticketsByPriority: byPriority, ticketsByIssueType: byIssue,
  };
}

export async function summarizeInsights(llm, insights) {
  const resp = await llm.complete({
    system: 'You are an operations analyst for a vehicle rental company. Summarise ONLY the JSON data provided: what needs attention first and why, in at most 120 words and 3-5 short bullet lines. Do not invent numbers, records or causes that are not in the data. If the data is empty, say so.',
    messages: [{ role: 'user', content: JSON.stringify({ totals: insights.totals, pendingBookings: insights.pendingBookings, openTickets: insights.openTickets }) }],
    maxTokens: 400,
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
