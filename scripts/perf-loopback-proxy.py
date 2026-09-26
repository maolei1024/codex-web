"""Temporary browser-container loopback relays; stop automatically when stdin closes."""
import asyncio
import sys


async def relay(reader, writer, target_port):
    remote_writer = None
    try:
        remote_reader, remote_writer = await asyncio.open_connection("100.90.94.39", target_port)

        async def copy(source, destination):
            while chunk := await source.read(65536):
                destination.write(chunk)
                await destination.drain()

        tasks = [asyncio.create_task(copy(reader, remote_writer)), asyncio.create_task(copy(remote_reader, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()
        if remote_writer:
            remote_writer.close()


async def main():
    servers = []
    try:
        for port, target in [(28214, 28214), (28215, 8214)]:
            servers.append(await asyncio.start_server(
                lambda r, w, t=target: relay(r, w, t), "127.0.0.1", port))
        print("loopback-relays-ready", flush=True)
        await asyncio.to_thread(sys.stdin.buffer.read)
    finally:
        for server in servers:
            server.close()
            await server.wait_closed()


asyncio.run(main())
