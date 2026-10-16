import { escapeHtml } from '@opend/render-html';

export type TopicType = 'concept' | 'task' | 'reference' | 'topic';

export const TOPIC_TYPES: { type: TopicType; label: string }[] = [
  { type: 'concept', label: 'Concept: explains what something is' },
  { type: 'task', label: 'Task: step-by-step instructions' },
  { type: 'reference', label: 'Reference: facts to look up' },
  { type: 'topic', label: 'General topic' },
];

const DOCTYPES: Record<TopicType, string> = {
  concept: '<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">',
  task: '<!DOCTYPE task PUBLIC "-//OASIS//DTD DITA Task//EN" "task.dtd">',
  reference: '<!DOCTYPE reference PUBLIC "-//OASIS//DTD DITA Reference//EN" "reference.dtd">',
  topic: '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">',
};

const BODIES: Record<TopicType, string> = {
  concept: `  <conbody>
    <p>Explain the idea here.</p>
  </conbody>`,
  task: `  <taskbody>
    <context>
      <p>Say when and why someone does this.</p>
    </context>
    <steps>
      <step>
        <cmd>Describe the first step.</cmd>
      </step>
      <step>
        <cmd>Describe the next step.</cmd>
      </step>
    </steps>
    <result>
      <p>Describe what the reader has achieved.</p>
    </result>
  </taskbody>`,
  reference: `  <refbody>
    <section>
      <title>Details</title>
      <p>List the facts here.</p>
    </section>
  </refbody>`,
  topic: `  <body>
    <p>Write the content here.</p>
  </body>`,
};

/** A new, valid topic of the given type. */
export function topicTemplate(type: TopicType, id: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
${DOCTYPES[type]}
<${type} id="${escapeHtml(id)}">
  <title>${escapeHtml(title)}</title>
  <shortdesc>One sentence that says what this topic is about.</shortdesc>
${BODIES[type]}
</${type}>
`;
}
