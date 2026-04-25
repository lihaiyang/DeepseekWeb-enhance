"""Local shell and file operation tools."""

import os
import subprocess
import pathlib


def execute_command(command: str, timeout: int = 30) -> str:
    """Execute a shell command and return stdout/stderr."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=os.getcwd(),
        )
        output = result.stdout
        if result.stderr:
            output += ("\n--- stderr ---\n" if output else "") + result.stderr
        if result.returncode != 0:
            output += f"\n(exit code: {result.returncode})"
        return output or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s"
    except Exception as e:
        return f"Error: {e}"


def get_cwd() -> str:
    return os.getcwd()


def list_directory(path: str = ".") -> str:
    """List directory contents with type markers."""
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        return f"Error: path does not exist: {p}"
    if not p.is_dir():
        return f"Error: not a directory: {p}"

    entries = []
    try:
        for item in sorted(p.iterdir()):
            prefix = "d " if item.is_dir() else "f "
            size = ""
            if item.is_file():
                try:
                    size = f" ({item.stat().st_size:,} bytes)"
                except OSError:
                    pass
            entries.append(f"{prefix}{item.name}{size}")
    except PermissionError:
        return f"Error: permission denied: {p}"

    return "\n".join(entries) if entries else "(empty directory)"


def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_048_576) -> str:
    """Read file content. Limited to 1MB by default."""
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        return f"Error: file does not exist: {p}"
    if not p.is_file():
        return f"Error: not a file: {p}"
    try:
        size = p.stat().st_size
        if size > max_bytes:
            return f"Error: file too large ({size:,} bytes, limit {max_bytes:,})"
        return p.read_text(encoding=encoding)
    except UnicodeDecodeError:
        return f"Error: cannot decode as {encoding}"
    except Exception as e:
        return f"Error: {e}"


def write_file(path: str, content: str, encoding: str = "utf-8") -> str:
    """Write content to a file."""
    p = pathlib.Path(path).expanduser().resolve()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding=encoding)
        return f"Written {len(content):,} characters to {p}"
    except Exception as e:
        return f"Error: {e}"


# Tool metadata for MCP registration
TOOL_DEFINITIONS = [
    {
        "name": "execute_command",
        "description": "Execute a shell command and return the output",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "get_cwd",
        "description": "Get the current working directory",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_directory",
        "description": "List contents of a directory",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (default: current directory)"},
            },
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to read"},
                "encoding": {"type": "string", "description": "File encoding (default: utf-8)"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write"},
                "content": {"type": "string", "description": "Content to write"},
                "encoding": {"type": "string", "description": "File encoding (default: utf-8)"},
            },
            "required": ["path", "content"],
        },
    },
]

HANDLERS = {
    "execute_command": lambda args: execute_command(args.get("command", ""), args.get("timeout", 30)),
    "get_cwd": lambda args: get_cwd(),
    "list_directory": lambda args: list_directory(args.get("path", ".")),
    "read_file": lambda args: read_file(args.get("path", ""), args.get("encoding", "utf-8")),
    "write_file": lambda args: write_file(args.get("path", ""), args.get("content", ""), args.get("encoding", "utf-8")),
}
