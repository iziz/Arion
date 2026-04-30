type Task = {
  id: string;
  run: () => Promise<void>;
};

const tasks: Task[] = [];
let running = false;

export function enqueueLocalTask(id: string, run: () => Promise<void>) {
  tasks.push({ id, run });
  void drain();
}

export function getQueueDepth() {
  return tasks.length + (running ? 1 : 0);
}

async function drain() {
  if (running) return;
  running = true;
  while (tasks.length > 0) {
    const task = tasks.shift();
    if (!task) continue;
    await task.run();
  }
  running = false;
}
