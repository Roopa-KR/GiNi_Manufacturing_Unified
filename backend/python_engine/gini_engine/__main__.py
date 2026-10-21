"""python -m gini_engine            -> run the always-on worker
python -m gini_engine <command>  -> one-off maintenance command (check | indexes | init | calc | recovery | reduce), see cli.py"""
import sys

if len(sys.argv) > 1:
    from .cli import main as cli_main
    sys.exit(cli_main(sys.argv[1:]))
from .worker import main

main()
